from fastapi import FastAPI, UploadFile, File, Form, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
import os
import sys
import shutil
import tempfile
import json
import datetime
import hashlib
from collections import defaultdict
from pathlib import Path
from app.parser import parse_bank_statement
from app.categorizer import load_user_mappings, get_needs_wants_mapping
import google.generativeai as genai
from pydantic import BaseModel
from typing import Dict, Any, Optional, List

# Ensure persistent data directory exists
DATA_DIR = Path.home() / ".spend_analyzer"
DATA_DIR.mkdir(exist_ok=True)

# Resolve static directory for PyInstaller
def get_static_path():
    if hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, 'static')
    return "static"

app = FastAPI()
app.mount("/static", StaticFiles(directory=get_static_path()), name="static")

TX_OVERRIDES_FILE = DATA_DIR / "tx_overrides.json"
_tx_overrides = {}

def load_tx_overrides():
    global _tx_overrides
    if os.path.exists(TX_OVERRIDES_FILE):
        try:
            with open(TX_OVERRIDES_FILE, "r") as f:
                _tx_overrides = json.load(f)
        except:
            _tx_overrides = {}

def save_tx_override(tx_id: str, field: str, value: str):
    global _tx_overrides
    if tx_id not in _tx_overrides:
        _tx_overrides[tx_id] = {}
    _tx_overrides[tx_id][field] = value
    with open(TX_OVERRIDES_FILE, "w") as f:
        json.dump(_tx_overrides, f, indent=4)

# Load on startup
load_tx_overrides()

@app.get("/", response_class=HTMLResponse)
async def read_index():
    index_path = os.path.join(get_static_path(), "index.html")
    with open(index_path, "r", encoding="utf-8") as f:
        return HTMLResponse(content=f.read())

def parse_month_year(date_str):
    try:
        clean_date = date_str.replace('.', '-').replace('/', '-')
        dt = datetime.datetime.strptime(clean_date, "%d-%m-%Y")
        return dt.strftime("%b %Y"), dt
    except:
        return "Unknown", None

def aggregate_dashboard_data(transactions, opening_balance, closing_balance):
    # Keep raw totals for reconciliation to ensure we parsed everything
    raw_total_in = sum(t["amount"] for t in transactions if t.get("type") == "Credit")
    raw_total_out = sum(t["amount"] for t in transactions if t.get("type") == "Debit")
    
    computed_net = raw_total_in - raw_total_out
    statement_net = closing_balance - opening_balance
    reconciliation_diff = round(computed_net - statement_net, 2)
    
    EXCLUDED_CATEGORIES = ["Family/Self Transfer", "Ignored/Refund"]
    total_in = sum(t["amount"] for t in transactions if t.get("type") == "Credit" and t.get("category") == "Income")
    total_out_debits = sum(t["amount"] for t in transactions if t.get("type") == "Debit" and t.get("category") not in EXCLUDED_CATEGORIES)
    total_out_credits = sum(t["amount"] for t in transactions if t.get("type") == "Credit" and t.get("category") not in EXCLUDED_CATEGORIES and t.get("category") != "Income")
    total_out = total_out_debits - total_out_credits
    net = total_in - total_out

    monthly_net_burns = defaultdict(float)
    months_set = set()
    
    category_sums = defaultdict(float)
    category_counts = defaultdict(int)
    monthly_spend = defaultdict(float)
    monthly_in = defaultdict(float)
    monthly_categories = defaultdict(lambda: defaultdict(float))
    monthly_needs_wants = defaultdict(lambda: defaultdict(float))
    monthly_transactions = defaultdict(list)
    merchant_counts = defaultdict(int)
    merchant_sums = defaultdict(float)

    for tx in transactions:
        if "tx_id" not in tx:
            raw_str = f'{tx.get("date", "")}_{tx.get("merchant", "")}_{tx.get("amount", "")}_{tx.get("balance", "")}'
            tx["tx_id"] = hashlib.md5(raw_str.encode('utf-8')).hexdigest()

        # Apply any persisted per-transaction overrides (category, month_year)
        if tx["tx_id"] in _tx_overrides:
            for field, val in _tx_overrides[tx["tx_id"]].items():
                tx[field] = val

        if "month_year" not in tx or tx["month_year"] == "Unknown":
            my, dt = parse_month_year(tx.get("date", ""))
            tx["month_year"] = my
        else:
            my = tx["month_year"]
            
        if my != "Unknown":
            months_set.add(my)
            if tx.get("category") not in EXCLUDED_CATEGORIES:
                if tx.get("type") == "Debit":
                    monthly_net_burns[my] += tx.get("amount", 0)
                else:
                    monthly_net_burns[my] -= tx.get("amount", 0)

        if tx.get("type") == "Debit":
            category_sums[tx.get("category")] += tx.get("amount", 0)
            category_counts[tx.get("category")] += 1
            
            if tx.get("category") not in EXCLUDED_CATEGORIES:
                monthly_spend[my] += tx.get("amount", 0)
                
            monthly_categories[my][tx.get("category")] += tx.get("amount", 0)
            monthly_transactions[my].append(tx)
            
            nw = get_needs_wants_mapping(tx.get("category"))
            monthly_needs_wants[my][nw] += tx.get("amount", 0)
            
            merchant_counts[tx.get("merchant")] += 1
            merchant_sums[tx.get("merchant")] += tx.get("amount", 0)
        else:
            if tx.get("category") not in EXCLUDED_CATEGORIES:
                if tx.get("category") == "Income":
                    monthly_in[my] += tx.get("amount", 0)
                else:
                    monthly_spend[my] -= tx.get("amount", 0)
                    category_sums[tx.get("category")] -= tx.get("amount", 0)
                    monthly_categories[my][tx.get("category")] -= tx.get("amount", 0)
                    nw = get_needs_wants_mapping(tx.get("category"))
                    monthly_needs_wants[my][nw] -= tx.get("amount", 0)

    avg_monthly_net_burn = sum(monthly_net_burns.values()) / len(months_set) if months_set else 0
    runway = round(closing_balance / avg_monthly_net_burn, 1) if avg_monthly_net_burn > 0 else "Infinite"

    investments_total = category_sums.get("Investments", 0)
    actual_spent = total_out - investments_total

    overview = {
        "total_in": total_in,
        "total_out": total_out,
        "net": net,
        "opening_balance": opening_balance,
        "closing_balance": closing_balance,
        "runway": runway,
        "reconciliation_diff": reconciliation_diff,
        "investments_total": investments_total,
        "actual_spent": actual_spent
    }

    categories = []
    for name, amount in category_sums.items():
        count = category_counts[name]
        months_active = len(months_set)
        avg_per_month = amount / months_active if months_active else amount
        categories.append({
            "name": name,
            "amount": round(amount, 2),
            "count": count,
            "avg_per_month": round(avg_per_month, 2),
            "percent": round((amount / total_out) * 100, 1) if total_out else 0,
            "insight": f"{count} orders, ~₹{round(avg_per_month):,}/month"
        })
    categories.sort(key=lambda x: x["amount"], reverse=True)

    month_verdicts = {}
    for m in sorted(list(months_set), key=lambda x: datetime.datetime.strptime(x, "%b %Y")):
        net_m = monthly_in[m] - monthly_spend[m]
        txs_m = monthly_transactions[m]
        if not txs_m:
            month_verdicts[m] = {"net": round(net_m, 2), "reason": "No debits this month"}
            continue
        
        cats_m = monthly_categories[m]
        biggest_cat = max(cats_m, key=cats_m.get)
        biggest_tx = max(txs_m, key=lambda x: x["amount"])
        
        if biggest_tx["amount"] > cats_m[biggest_cat] * 0.5:
            reason = f"Heavy {biggest_tx['category']} payment (₹{biggest_tx['amount']:,}) dominated outflow"
        else:
            reason = f"{biggest_cat} (₹{cats_m[biggest_cat]:,}) was the biggest driver"
        
        month_verdicts[m] = {"net": round(net_m, 2), "reason": reason}

    monthly_categories_list = {}
    for month, cat_dict in monthly_categories.items():
        sorted_cats = [{"name": k, "amount": round(v, 2)} for k, v in cat_dict.items()]
        sorted_cats.sort(key=lambda x: x["amount"], reverse=True)
        monthly_categories_list[month] = sorted_cats
        
    all_debits = [t for t in transactions if t.get("type") == "Debit"]
    top_15_overall = sorted(all_debits, key=lambda x: x["amount"], reverse=True)[:15]
    
    frequent_merchants = []
    for m, c in merchant_counts.items():
        frequent_merchants.append({"merchant": m, "count": c, "amount": round(merchant_sums[m], 2)})
    frequent_merchants.sort(key=lambda x: x["count"], reverse=True)
    top_frequent = frequent_merchants[:15]

    monthly_trends = {
        "income": {k: round(v, 2) for k, v in monthly_in.items()},
        "spend": {k: round(v, 2) for k, v in monthly_spend.items()},
        "net": {k: round(monthly_in[k] - monthly_spend[k], 2) for k in monthly_spend.keys()},
        "categories": monthly_categories_list,
        "needs_wants": {k: {nk: round(nv, 2) for nk, nv in v.items()} for k, v in monthly_needs_wants.items()}
    }

    return {
        "overview": overview,
        "transactions": transactions,
        "categories": categories,
        "monthly_trends": monthly_trends,
        "month_verdicts": month_verdicts,
        "top_15_overall": top_15_overall,
        "top_frequent": top_frequent
    }

@app.post("/api/upload")
async def process_upload(
    bank_statement: UploadFile = File(...),
    context_note: str = Form(None)
):
    try:
        suffix = os.path.splitext(bank_statement.filename)[1]
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            shutil.copyfileobj(bank_statement.file, tmp)
            tmp_path = tmp.name

        try:
            transactions = parse_bank_statement(tmp_path)
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

        if not transactions:
            return {"status": "error", "message": "No transactions found"}

        opening_balance = transactions[0].get("balance", 0) if transactions else 0
        closing_balance = transactions[-1].get("balance", 0) if transactions else 0

        dashboard_data = aggregate_dashboard_data(transactions, opening_balance, closing_balance)
        
        # Save session
        with open(DATA_DIR / "current_data.json", "w") as f:
            json.dump({"transactions": transactions, "opening_balance": opening_balance, "closing_balance": closing_balance}, f)
            
        return {"status": "success", "data": dashboard_data}
    except Exception as e:
        print(f"Parsing Error: {str(e)}")
        return {"status": "error", "message": str(e)}

@app.get("/api/load-session")
async def load_session():
    data_file = DATA_DIR / "current_data.json"
    if os.path.exists(data_file):
        try:
            with open(data_file, "r") as f:
                saved = json.load(f)
            transactions = saved.get("transactions", [])
            ob = saved.get("opening_balance", 0)
            cb = saved.get("closing_balance", 0)
            if transactions:
                dashboard_data = aggregate_dashboard_data(transactions, ob, cb)
                return {"status": "success", "data": dashboard_data}
        except Exception as e:
            print(f"Session load error: {e}")
    return {"status": "error", "message": "No active session"}

@app.post("/api/clear-session")
async def clear_session():
    data_file = DATA_DIR / "current_data.json"
    if os.path.exists(data_file):
        os.remove(data_file)
    return {"status": "success"}

@app.post("/api/mapping")
async def update_mapping(request: Request):
    data = await request.json()
    merchant = data.get("merchant")
    category = data.get("category")
    
    if not merchant or not category:
        return {"status": "error", "message": "Missing merchant or category"}
        
    mappings = {}
    mapping_file = DATA_DIR / "user_mappings.json"
    if os.path.exists(mapping_file):
        with open(mapping_file, "r") as f:
            try:
                mappings = json.load(f)
            except:
                pass
                
    mappings[merchant] = category
    with open(mapping_file, "w") as f:
        json.dump(mappings, f, indent=4)
        
    load_user_mappings()
    return {"status": "success"}

@app.post("/api/tx-override")
async def tx_override(request: Request):
    try:
        data = await request.json()
        tx_id = data.get("tx_id")
        field = data.get("field")   # "category" or "month_year"
        value = data.get("value")
        if not tx_id or not field or value is None:
            return {"status": "error", "message": "Missing tx_id, field, or value"}
        save_tx_override(tx_id, field, value)
        return {"status": "success"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/recalculate")
async def recalculate_dashboard(request: Request):
    try:
        data = await request.json()
        transactions = data.get("transactions", [])
        
        if not transactions:
             return {"status": "error", "message": "No transactions provided"}
             
        opening_balance = transactions[0].get("balance", 0) if transactions else 0
        closing_balance = transactions[-1].get("balance", 0) if transactions else 0
        
        # Update the session file so refreshes keep the modified state
        with open(DATA_DIR / "current_data.json", "w") as f:
            json.dump({"transactions": transactions, "opening_balance": opening_balance, "closing_balance": closing_balance}, f)
            
        dashboard_data = aggregate_dashboard_data(transactions, opening_balance, closing_balance)
        return {"status": "success", "data": dashboard_data}
    except Exception as e:
        print(f"Recalculate Error: {str(e)}")
        return {"status": "error", "message": str(e)}

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    message: str
    history: List[ChatMessage]
    context_data: Dict[str, Any]
    api_key: Optional[str] = None

@app.post("/api/chat")
async def chat_endpoint(request: ChatRequest):
    try:
        api_key = os.getenv("GEMINI_API_KEY", "")
        config_path = DATA_DIR / "config.json"
        if not api_key and os.path.exists(config_path):
            with open(config_path, "r") as f:
                config_data = json.load(f)
                api_key = config_data.get("GEMINI_API_KEY", "")
                
        if not api_key:
            return {"status": "error", "message": "API key not configured."}
        
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel('gemini-2.5-flash')
        
        # Prepare context
        context_str = json.dumps(request.context_data, indent=2)
        system_prompt = f"You are a helpful financial assistant. You have access to the user's parsed bank statement and dashboard data. Use this data to answer their questions accurately and concisely.\n\nContext Data:\n{context_str}"
        
        # Convert history
        messages = [{"role": "user", "parts": [system_prompt]}]
        # Gemini expects alternating user/model if using chat history, but since we are just passing context, 
        # let's just build a single prompt or use the chat session.
        # Actually, let's just use generate_content with all history as a single prompt for simplicity.
        
        prompt = system_prompt + "\n\nChat History:\n"
        for msg in request.history:
            prompt += f"{msg.role.capitalize()}: {msg.content}\n"
        
        prompt += f"User: {request.message}\nAssistant:"
        
        response = model.generate_content(prompt)
        return {"status": "success", "reply": response.text}
    except Exception as e:
        print(f"Chat Error: {str(e)}")
        return {"status": "error", "message": str(e)}

@app.post("/api/export")
async def export_excel(request: Request):
    try:
        import pandas as pd
        import io
        from fastapi.responses import StreamingResponse

        data = await request.json()
        
        output = io.BytesIO()
        with pd.ExcelWriter(output, engine='openpyxl') as writer:
            if "overview" in data:
                pd.DataFrame([data["overview"]]).to_excel(writer, sheet_name="Overview", index=False)
            
            if "transactions" in data:
                df_tx = pd.DataFrame(data["transactions"])
                if not df_tx.empty:
                    df_tx = df_tx.drop(columns=["tx_id"], errors="ignore")
                df_tx.to_excel(writer, sheet_name="Transactions", index=False)
            
            if "categories" in data:
                pd.DataFrame(data["categories"]).to_excel(writer, sheet_name="Categories", index=False)
                
            if "top_15_overall" in data:
                pd.DataFrame(data["top_15_overall"]).to_excel(writer, sheet_name="Top 15 Overall", index=False)
                
            if "top_frequent" in data:
                pd.DataFrame(data["top_frequent"]).to_excel(writer, sheet_name="Top Frequent", index=False)
                
        output.seek(0)
        
        headers = {
            'Content-Disposition': 'attachment; filename="budget_analysis.xlsx"'
        }
        return StreamingResponse(output, headers=headers, media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        
    except Exception as e:
        print(f"Export Error: {str(e)}")
        return {"status": "error", "message": str(e)}
