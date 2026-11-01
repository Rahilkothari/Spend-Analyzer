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

@app.middleware("http")
async def add_no_cache_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

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

def parse_date_obj(date_str):
    if not date_str:
        return None
    clean = str(date_str).strip().replace('.', '-').replace('/', '-')
    formats = [
        "%d-%m-%Y",
        "%d-%m-%y",
        "%Y-%m-%d",
        "%d-%b-%Y",
        "%d-%b-%y",
        "%d-%B-%Y"
    ]
    for fmt in formats:
        try:
            return datetime.datetime.strptime(clean, fmt)
        except ValueError:
            pass
    return None

def month_sort_key(m_str):
    try:
        return datetime.datetime.strptime(m_str, "%b %Y")
    except:
        return datetime.datetime.min

def parse_month_year(date_str):
    dt = parse_date_obj(date_str)
    if dt:
        return dt.strftime("%b %Y"), dt
    return "Unknown", None


def compute_spend_insights(transactions, sorted_months, total_spend, avg_monthly_spend, category_sums):
    months_count = len(sorted_months) if sorted_months else 1
    
    # 1. Micro-spend (< ₹500)
    micro_txs = [t for t in transactions if float(t.get("amount", 0)) <= 500 and t.get("category") != "Ignored/Refund"]
    micro_total = sum(float(t.get("amount", 0)) for t in micro_txs)
    micro_count = len(micro_txs)
    
    micro_merchants = defaultdict(lambda: {"count": 0, "amount": 0.0})
    for t in micro_txs:
        m = t.get("merchant", "Unknown")
        micro_merchants[m]["count"] += 1
        micro_merchants[m]["amount"] += float(t.get("amount", 0))
    top_micro = [
        {"merchant": m, "count": stats["count"], "amount": round(stats["amount"], 2)}
        for m, stats in sorted(micro_merchants.items(), key=lambda x: x[1]["amount"], reverse=True)[:6]
    ]
    
    micro_spend_data = {
        "count": micro_count,
        "total": round(micro_total, 2),
        "pct_txs": round((micro_count / len(transactions)) * 100, 1) if transactions else 0,
        "pct_spend": round((micro_total / total_spend) * 100, 1) if total_spend else 0,
        "monthly_avg": round(micro_total / months_count, 2),
        "top_merchants": top_micro
    }
    
    # 2. Fixed vs Controllable Spend
    fixed_cats = {"Rent", "Education/Loan EMI", "Bills-Recharge/Internet", "Bills-Subscriptions", "Investments", "CC Payment"}
    fixed_spend = sum(float(t.get("amount", 0)) for t in transactions if t.get("category") in fixed_cats)
    control_spend = total_spend - fixed_spend
    fixed_vs_variable_data = {
        "fixed_total": round(fixed_spend, 2),
        "fixed_pct": round((fixed_spend / total_spend) * 100, 1) if total_spend else 0,
        "fixed_monthly": round(fixed_spend / months_count, 2),
        "control_total": round(control_spend, 2),
        "control_pct": round((control_spend / total_spend) * 100, 1) if total_spend else 0,
        "control_monthly": round(control_spend / months_count, 2)
    }
    
    # 3. Category Spike Alerts
    cat_monthly = defaultdict(lambda: defaultdict(float))
    for t in transactions:
        if t.get("category") not in ("Ignored/Refund", "Investments"):
            cat_monthly[t.get("category")][t.get("month_year")] += float(t.get("amount", 0))
            
    spike_alerts = []
    for cat, m_map in cat_monthly.items():
        cat_avg = sum(m_map.values()) / months_count
        if cat_avg < 1000:
            continue
        for m in sorted_months:
            amt = m_map.get(m, 0)
            if amt >= 2000 and amt >= cat_avg * 1.35:
                pct = round(((amt - cat_avg) / cat_avg) * 100, 1)
                spike_alerts.append({
                    "month": m,
                    "category": cat,
                    "amount": round(amt, 2),
                    "avg": round(cat_avg, 2),
                    "pct_change": pct
                })
    spike_alerts.sort(key=lambda x: (month_sort_key(x["month"]), -x["pct_change"]))
    
    # 4. Weekend vs Weekday
    weekday_amt = 0.0
    weekend_amt = 0.0
    weekday_cnt = 0
    weekend_cnt = 0
    weekend_cats = defaultdict(float)
    weekday_cats = defaultdict(float)
    for t in transactions:
        if t.get("category") == "Ignored/Refund":
            continue
        amt = float(t.get("amount", 0))
        dt = parse_date_obj(t.get("date"))
        if dt:
            if dt.weekday() in (4, 5, 6): # Fri, Sat, Sun
                weekend_amt += amt
                weekend_cnt += 1
                weekend_cats[t.get("category")] += amt
            else:
                weekday_amt += amt
                weekday_cnt += 1
                weekday_cats[t.get("category")] += amt
                
    weekend_vs_weekday_data = {
        "weekday_total": round(weekday_amt, 2),
        "weekday_count": weekday_cnt,
        "weekday_avg_txn": round(weekday_amt / weekday_cnt, 2) if weekday_cnt else 0,
        "weekend_total": round(weekend_amt, 2),
        "weekend_count": weekend_cnt,
        "weekend_avg_txn": round(weekend_amt / weekend_cnt, 2) if weekend_cnt else 0,
        "top_weekend_cats": sorted([{"name": k, "amount": round(v, 2)} for k, v in weekend_cats.items()], key=lambda x: x["amount"], reverse=True)[:4]
    }
    
    # 5. Top Merchants & Annualized Run-Rate
    merch_stats = defaultdict(lambda: {"count": 0, "amount": 0.0, "category": ""})
    for t in transactions:
        if t.get("category") == "Ignored/Refund":
            continue
        m = t.get("merchant", "Unknown")
        merch_stats[m]["count"] += 1
        merch_stats[m]["amount"] += float(t.get("amount", 0))
        merch_stats[m]["category"] = t.get("category", "Other")
        
    top_merchants_annualized = []
    for m, s in sorted(merch_stats.items(), key=lambda x: x[1]["amount"], reverse=True)[:8]:
        mo_avg = s["amount"] / months_count
        top_merchants_annualized.append({
            "merchant": m,
            "category": s["category"],
            "count": s["count"],
            "total_amount": round(s["amount"], 2),
            "monthly_avg": round(mo_avg, 2),
            "annualized": round(mo_avg * 12, 2)
        })
        
    # 6. Spend Velocity (Day 1 to 31 cumulative burn)
    month_daily = defaultdict(lambda: [0.0] * 32)
    for t in transactions:
        if t.get("category") == "Ignored/Refund":
            continue
        m = t.get("month_year")
        dt = parse_date_obj(t.get("date"))
        if dt and m in sorted_months:
            day = min(max(dt.day, 1), 31)
            month_daily[m][day] += float(t.get("amount", 0))
            
    spend_velocity = {}
    for m in sorted_months:
        daily = month_daily[m]
        cumulative = []
        running = 0.0
        for d in range(1, 32):
            running += daily[d]
            cumulative.append(round(running, 2))
        spend_velocity[m] = cumulative
        
    return {
        "micro_spend": micro_spend_data,
        "fixed_vs_variable": fixed_vs_variable_data,
        "spike_alerts": spike_alerts,
        "weekend_vs_weekday": weekend_vs_weekday_data,
        "top_merchants_annualized": top_merchants_annualized,
        "spend_velocity": spend_velocity
    }

def aggregate_dashboard_data(transactions, opening_balance=0, closing_balance=0):
    # Strictly filter for debits (spends only). Credits are completely excluded.
    transactions = [t for t in transactions if t.get("type") == "Debit"]
    
    EXCLUDED_CATEGORIES = ["Ignored/Refund"]

    monthly_net_burns = defaultdict(float)
    months_set = set()
    
    category_sums = defaultdict(float)
    category_counts = defaultdict(int)
    monthly_spend = defaultdict(float)
    monthly_categories = defaultdict(lambda: defaultdict(float))
    monthly_needs_wants = defaultdict(lambda: defaultdict(float))
    monthly_transactions = defaultdict(list)
    merchant_counts = defaultdict(int)
    merchant_sums = defaultdict(float)

    total_spend = 0.0

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
            
        amt = float(tx.get("amount", 0))
        cat = tx.get("category", "Other")

        if my != "Unknown":
            months_set.add(my)

        if cat not in EXCLUDED_CATEGORIES:
            total_spend += amt
            monthly_net_burns[my] += amt
            category_sums[cat] += amt
            category_counts[cat] += 1
            monthly_spend[my] += amt
            monthly_categories[my][cat] += amt
            monthly_transactions[my].append(tx)
            
            nw = get_needs_wants_mapping(cat)
            monthly_needs_wants[my][nw] += amt
            
            merch = tx.get("merchant", "Unknown")
            merchant_counts[merch] += 1
            merchant_sums[merch] += amt

    sorted_months = sorted(list(months_set), key=month_sort_key)
    months_count = len(sorted_months)
    avg_monthly_spend = round(total_spend / months_count, 2) if months_count else round(total_spend, 2)

    investments_total = category_sums.get("Investments", 0)
    actual_spent = total_spend - investments_total

    highest_month = max(monthly_spend, key=monthly_spend.get) if monthly_spend else ""
    highest_month_spend = round(monthly_spend[highest_month], 2) if highest_month else 0

    period_str = ""
    if sorted_months:
        if len(sorted_months) == 1:
            period_str = sorted_months[0]
        else:
            period_str = f"{sorted_months[0]} - {sorted_months[-1]}"

    overview = {
        "total_spend": round(total_spend, 2),
        "total_out": round(total_spend, 2),
        "avg_monthly_spend": avg_monthly_spend,
        "investments_total": round(investments_total, 2),
        "actual_spent": round(actual_spent, 2),
        "highest_month": highest_month,
        "highest_month_spend": highest_month_spend,
        "months_count": months_count,
        "months_list": sorted_months,
        "period_str": period_str,
        "tx_count": len(transactions)
    }

    categories = []
    for name, amount in category_sums.items():
        count = category_counts[name]
        avg_per_month = amount / months_count if months_count else amount
        categories.append({
            "name": name,
            "amount": round(amount, 2),
            "count": count,
            "avg_per_month": round(avg_per_month, 2),
            "percent": round((amount / total_spend) * 100, 1) if total_spend else 0,
            "insight": f"{count} orders, ~₹{round(avg_per_month):,}/month"
        })
    categories.sort(key=lambda x: x["amount"], reverse=True)

    month_verdicts = {}
    for m in sorted_months:
        spend_m = monthly_spend[m]
        txs_m = monthly_transactions[m]
        if not txs_m:
            month_verdicts[m] = {
                "spend": round(spend_m, 2),
                "vs_avg": 0,
                "reason": "No debits this month"
            }
            continue
        
        cats_m = monthly_categories[m]
        biggest_cat = max(cats_m, key=cats_m.get) if cats_m else "Other"
        biggest_cat_amt = cats_m.get(biggest_cat, 0)
        
        cat_txs = [t for t in txs_m if t.get("category") == biggest_cat]
        biggest_tx_in_cat = max(cat_txs, key=lambda x: x["amount"]) if cat_txs else None
        
        if biggest_tx_in_cat and biggest_tx_in_cat["amount"] >= biggest_cat_amt * 0.7 and biggest_tx_in_cat["amount"] >= spend_m * 0.2:
            reason = f"Heavy {biggest_cat} payment (₹{round(biggest_tx_in_cat['amount']):,}) dominated outflow"
        else:
            reason = f"{biggest_cat} (₹{round(biggest_cat_amt):,}) was the biggest driver"
        
        vs_avg = round(((spend_m - avg_monthly_spend) / avg_monthly_spend) * 100, 1) if avg_monthly_spend > 0 else 0
        
        month_verdicts[m] = {
            "spend": round(spend_m, 2),
            "vs_avg": vs_avg,
            "reason": reason
        }

    monthly_categories_list = {}
    for month, cat_dict in monthly_categories.items():
        sorted_cats = [{"name": k, "amount": round(v, 2)} for k, v in cat_dict.items()]
        sorted_cats.sort(key=lambda x: x["amount"], reverse=True)
        monthly_categories_list[month] = sorted_cats
        
    top_15_overall = sorted(transactions, key=lambda x: x["amount"], reverse=True)[:15]
    
    frequent_merchants = []
    for m, c in merchant_counts.items():
        frequent_merchants.append({"merchant": m, "count": c, "amount": round(merchant_sums[m], 2)})
    frequent_merchants.sort(key=lambda x: x["count"], reverse=True)
    top_frequent = frequent_merchants[:15]

    monthly_trends = {
        "spend": {k: round(v, 2) for k, v in monthly_spend.items()},
        "avg_monthly_spend": avg_monthly_spend,
        "categories": monthly_categories_list
    }

    insights = compute_spend_insights(transactions, sorted_months, total_spend, avg_monthly_spend, category_sums)

    return {
        "overview": overview,
        "transactions": transactions,
        "categories": categories,
        "monthly_trends": monthly_trends,
        "month_verdicts": month_verdicts,
        "top_15_overall": top_15_overall,
        "top_frequent": top_frequent,
        "insights": insights
    }

def parse_uploaded_files(files: List[UploadFile]) -> List[dict]:
    all_transactions = []
    for file in files:
        if not file or not file.filename:
            continue
        suffix = os.path.splitext(file.filename)[1]
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            shutil.copyfileobj(file.file, tmp)
            tmp_path = tmp.name
        try:
            txs = parse_bank_statement(tmp_path)
            if txs:
                debits_only = [t for t in txs if t.get('type') == 'Debit']
                all_transactions.extend(debits_only)
        except Exception as e:
            print(f"Error parsing file {file.filename}: {e}")
            raise ValueError(f"Could not parse '{file.filename}': {str(e)}")
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
    return all_transactions

def merge_and_sort_transactions(existing_txs, new_txs, existing_ob, existing_cb):
    seen_ids = set()
    merged = []
    
    # Track existing
    for tx in existing_txs:
        tid = tx.get("tx_id")
        if not tid:
            raw_str = f'{tx.get("date", "")}_{tx.get("merchant", "")}_{tx.get("amount", "")}_{tx.get("balance", "")}'
            tid = hashlib.md5(raw_str.encode('utf-8')).hexdigest()
            tx["tx_id"] = tid
        if tid not in seen_ids:
            seen_ids.add(tid)
            merged.append(tx)
            
    added_count = 0
    new_non_dupes = []
    for tx in new_txs:
        tid = tx.get("tx_id")
        if not tid:
            raw_str = f'{tx.get("date", "")}_{tx.get("merchant", "")}_{tx.get("amount", "")}_{tx.get("balance", "")}'
            tid = hashlib.md5(raw_str.encode('utf-8')).hexdigest()
            tx["tx_id"] = tid
        if tid not in seen_ids:
            seen_ids.add(tid)
            merged.append(tx)
            new_non_dupes.append(tx)
            added_count += 1
            
    # Sort merged transactions chronologically
    def get_sort_key(t):
        dt = parse_date_obj(t.get("date", ""))
        return (dt if dt is not None else datetime.datetime.min)
        
    merged.sort(key=get_sort_key)
    
    # Calculate appropriate opening and closing balances
    if not existing_txs and merged:
        opening_balance = merged[0].get("balance", 0)
        closing_balance = merged[-1].get("balance", 0)
    elif merged:
        existing_dates = [parse_date_obj(t.get("date", "")) for t in existing_txs]
        existing_dates = [d for d in existing_dates if d is not None]
        
        new_dates = [parse_date_obj(t.get("date", "")) for t in new_non_dupes]
        new_dates = [d for d in new_dates if d is not None]
        
        opening_balance = existing_ob
        closing_balance = existing_cb
        
        if existing_dates and new_dates:
            if min(new_dates) < min(existing_dates):
                # New transactions are earlier in time
                opening_balance = merged[0].get("balance", existing_ob)
            if max(new_dates) > max(existing_dates):
                # New transactions are later in time
                closing_balance = merged[-1].get("balance", existing_cb)
        elif merged:
            opening_balance = merged[0].get("balance", existing_ob)
            closing_balance = merged[-1].get("balance", existing_cb)
    else:
        opening_balance = existing_ob
        closing_balance = existing_cb
        
    return merged, opening_balance, closing_balance, added_count

@app.post("/api/upload")
async def process_upload(
    bank_statement: Optional[UploadFile] = File(None),
    bank_statements: Optional[List[UploadFile]] = File(None),
    context_note: Optional[str] = Form(None)
):
    try:
        files = []
        if bank_statements:
            files.extend([f for f in bank_statements if f.filename])
        if bank_statement and bank_statement.filename:
            files.append(bank_statement)

        if not files:
            return {"status": "error", "message": "No file uploaded"}

        raw_txs = parse_uploaded_files(files)
        if not raw_txs:
            return {"status": "error", "message": "No transactions found in uploaded statement(s)"}

        merged, opening_balance, closing_balance, _ = merge_and_sort_transactions([], raw_txs, 0, 0)
        dashboard_data = aggregate_dashboard_data(merged, opening_balance, closing_balance)
        
        # Save session
        with open(DATA_DIR / "current_data.json", "w") as f:
            json.dump({"transactions": merged, "opening_balance": opening_balance, "closing_balance": closing_balance}, f)
            
        return {"status": "success", "data": dashboard_data, "added_count": len(merged), "total_count": len(merged)}
    except Exception as e:
        print(f"Parsing Error: {str(e)}")
        traceback.print_exc()
        return {"status": "error", "message": str(e)}

@app.post("/api/append-statement")
async def append_statement(
    bank_statement: Optional[UploadFile] = File(None),
    bank_statements: Optional[List[UploadFile]] = File(None),
    context_note: Optional[str] = Form(None)
):
    try:
        files = []
        if bank_statements:
            files.extend([f for f in bank_statements if f.filename])
        if bank_statement and bank_statement.filename:
            files.append(bank_statement)

        if not files:
            return {"status": "error", "message": "No statement file uploaded"}

        # Load existing session
        data_file = DATA_DIR / "current_data.json"
        existing_txs = []
        existing_ob = 0
        existing_cb = 0
        if os.path.exists(data_file):
            try:
                with open(data_file, "r") as f:
                    saved = json.load(f)
                existing_txs = saved.get("transactions", [])
                existing_ob = saved.get("opening_balance", 0)
                existing_cb = saved.get("closing_balance", 0)
            except Exception as e:
                print(f"Failed to load existing session during append: {e}")

        new_txs = parse_uploaded_files(files)
        if not new_txs:
            return {"status": "error", "message": "No transactions found in the new statement file(s)"}

        merged, opening_balance, closing_balance, added_count = merge_and_sort_transactions(
            existing_txs, new_txs, existing_ob, existing_cb
        )

        dashboard_data = aggregate_dashboard_data(merged, opening_balance, closing_balance)

        # Save updated session
        with open(DATA_DIR / "current_data.json", "w") as f:
            json.dump({"transactions": merged, "opening_balance": opening_balance, "closing_balance": closing_balance}, f)

        return {
            "status": "success",
            "data": dashboard_data,
            "added_count": added_count,
            "total_count": len(merged),
            "new_parsed_count": len(new_txs),
            "period_str": dashboard_data["overview"].get("period_str", ""),
            "months_count": dashboard_data["overview"].get("months_count", 1)
        }
    except Exception as e:
        print(f"Append Error: {str(e)}")
        traceback.print_exc()
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
        system_prompt = (
            "You are a helpful, expert financial assistant for Spend Analyzer. "
            "You have access to the user's complete bank statements, transactions, monthly trends, month verdicts, and category data.\n\n"
            "FINANCIAL RULES & DATA CONVENTIONS:\n"
            "1. 'Spend' represents total monthly expenses and consumption debits across all categories, which includes 'Family/Self Transfer', Rent, Investments, Food & Dining, Bills, etc.\n"
            "2. 'Category Explorer', 'Month-by-Month Verdicts', and 'Monthly Trends' are completely unified. For every month, the total spend reflects all debit transactions for that month.\n"
            "3. For example, for October 2026, total spend is ₹81,508.94 (displayed as ₹81,509). This includes ₹15,000 Rent, ₹14,650 Investments, ₹10,000 Family/Self Transfer, ₹9,880 Fun & Entertainment, ₹6,935 Food & Dining, etc., matching the Category Explorer Selected Total.\n"
            "4. For May 2026, total spend is ₹52,260.20 (including ₹10,000 Family/Self Transfer). For June 2026, total spend is ₹101,211.65 (including ₹25,000 Family/Self Transfer), etc.\n"
            "5. Always quote the accurate numbers from 'monthly_trends.spend' and 'month_verdicts' in the context data.\n\n"
            f"Context Data:\n{context_str}"
        )
        
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
                
                # Apply AutoFilter and Subtotal
                worksheet = writer.sheets["Transactions"]
                max_row = len(df_tx) + 1
                max_col = len(df_tx.columns)
                
                import openpyxl
                from openpyxl.utils import get_column_letter
                
                # Add auto filter
                worksheet.auto_filter.ref = f"A1:{get_column_letter(max_col)}{max_row}"
                
                # Find amount column and add subtotal
                amount_col_idx = None
                for idx, col_name in enumerate(df_tx.columns):
                    if col_name.lower() == "amount":
                        amount_col_idx = idx + 1
                        break
                
                if amount_col_idx:
                    worksheet.cell(row=max_row+1, column=1, value="Total")
                    worksheet.cell(row=max_row+1, column=1).font = openpyxl.styles.Font(bold=True)
                    
                    amt_letter = get_column_letter(amount_col_idx)
                    cell = worksheet.cell(row=max_row+1, column=amount_col_idx, value=f"=SUBTOTAL(109,{amt_letter}2:{amt_letter}{max_row})")
                    cell.font = openpyxl.styles.Font(bold=True)
                    
                # Adjust column widths for better visibility
                for col in worksheet.columns:
                    max_length = 0
                    column = col[0].column_letter
                    for cell in col:
                        try:
                            if len(str(cell.value)) > max_length:
                                max_length = len(str(cell.value))
                        except:
                            pass
                    adjusted_width = min(max_length + 2, 50)
                    worksheet.column_dimensions[column].width = adjusted_width
            
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
