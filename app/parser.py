import pdfplumber
import pandas as pd
import re
from datetime import datetime
from app.categorizer import categorize_transaction, extract_upi_note

def clean_amount(val):
    if not isinstance(val, str):
        return val
    # Remove commas, currency symbols, and spaces
    cleaned = re.sub(r'[^\d.-]', '', val)
    try:
        return float(cleaned)
    except ValueError:
        return None

def parse_bank_statement(file_path: str):
    """
    Generic PDF parser that extracts transactions and infers Debits/Credits via Balance Deltas.
    Includes text-based parsing for statements without borders (like ICICI) 
    and falls back to table-based parsing.
    """
    transactions = []
    
    is_excel = file_path.lower().endswith(('.xlsx', '.xls'))
    is_csv = file_path.lower().endswith('.csv')

    if is_excel or is_csv:
        if is_excel:
            df = pd.read_excel(file_path, header=None)
        else:
            df = pd.read_csv(file_path, header=None)
    else:
        # 1. Try text-based parsing first (very robust for specific known formats)
        with pdfplumber.open(file_path) as pdf:
            full_text = ""
            for page in pdf.pages:
                page_text = page.extract_text()
                if page_text:
                    full_text += page_text + "\n"
                    
        lines = [line.strip() for line in full_text.split('\n') if line.strip()]
        
        # We look for lines that match: SNo Date Amount Balance
        tx_starts = []
        for i, line in enumerate(lines):
            match = re.match(r'^(\d+)\s+(\d{2}[-./]\d{2}[-./]\d{4})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})$', line)
            if match:
                tx_starts.append((i, match))
                
        if len(tx_starts) > 0:
            prev_balance = None
            for idx, (line_idx, match) in enumerate(tx_starts):
                sno, date_str, amount_str, balance_str = match.groups()
                amount = float(amount_str.replace(',', ''))
                current_balance = float(balance_str.replace(',', ''))
                
                # Extract description
                desc_lines = []
                
                # Line above
                if line_idx > 0:
                    above = lines[line_idx-1]
                    if not re.match(r'^(\d+)\s+(\d{2}[-./]\d{2}[-./]\d{4})', above) and 'Balance' not in above and 'Amount' not in above:
                        desc_lines.append(above)
                        
                # Lines below until next transaction or page footer
                next_limit = tx_starts[idx+1][0] if idx + 1 < len(tx_starts) else len(lines)
                for j in range(line_idx + 1, min(line_idx + 6, next_limit)):
                    below = lines[j]
                    if re.match(r'^(\d+)\s+(\d{2}[-./]\d{2}[-./]\d{4})', below):
                        break
                    if 'www.icici.bank.in' in below or 'Page ' in below:
                        break
                    desc_lines.append(below)
                    
                desc = " ".join(desc_lines)
                
                if prev_balance is None:
                    prev_balance = current_balance
                    continue
                    
                delta = current_balance - prev_balance
                if abs(delta) < 0.01:
                    prev_balance = current_balance
                    continue
                    
                tx_type = "Credit" if delta > 0 else "Debit"
                actual_amount = abs(delta)
                
                note = extract_upi_note(desc)
                category = categorize_transaction(desc, actual_amount, tx_type, note)
                
                transactions.append({
                    "date": date_str,
                    "merchant": desc[:50] + ("..." if len(desc) > 50 else ""),
                    "note": note,
                    "category": category,
                    "type": tx_type,
                    "amount": round(actual_amount, 2),
                    "balance": round(current_balance, 2)
                })
                
                prev_balance = current_balance
                
            return transactions

        # 2. Fallback to table extraction for PDFs
        all_rows = []
        with pdfplumber.open(file_path) as pdf:
            for page in pdf.pages:
                ts = {"vertical_strategy": "text", "horizontal_strategy": "text"}
                tables = page.extract_tables(table_settings=ts)
                if not tables:
                    continue
                    
                main_table = max(tables, key=len)
                main_table = [row for row in main_table if any(cell and str(cell).strip() for cell in row)]
                all_rows.extend(main_table)

        if not all_rows:
            raise ValueError("No tables found in the PDF.")

        df = pd.DataFrame(all_rows)

    # Common DataFrame parsing for both Excel/CSV and PDF tables
    
    header_idx = -1
    is_cbin_format = False
    for i in range(min(25, len(df))):
        row_str = " ".join(str(x).lower().replace('\n', ' ').strip() for x in df.iloc[i].values if pd.notna(x) and str(x).strip())
        row_str = " ".join(row_str.split()) # normalize whitespace
        if 'date' in row_str and ('balance' in row_str or 'bal' in row_str):
            header_idx = i
            break
        elif 'post date' in row_str and 'transaction description' in row_str:
            header_idx = i
            is_cbin_format = True
            break
            
    if header_idx == -1:
        print("--- HEADER DETECTION FAILED ---")
        for i in range(min(25, len(df))):
            row_str = " ".join(str(x).lower() for x in df.iloc[i].values if x)
            print(f"Row {i} str: '{row_str}'")
            print(f"Row {i} values:", df.iloc[i].values)
        raise ValueError("Could not detect table headers automatically.")

    if is_cbin_format:
        # CBIN Excel format: 
        # Col 1: Date, Col 4: Desc, Col 5: Debit, Col 6: Credit. Spans multiple rows. No Balance column.
        df = df[header_idx+1:].reset_index(drop=True)
        txs = []
        current_tx = None
        
        # Track a pseudo-balance for UI consistency
        pseudo_balance = 0.0

        for _, row in df.iterrows():
            date_val = str(row[1]).strip() if pd.notna(row[1]) else ''
            desc_val = str(row[4]).strip() if pd.notna(row[4]) else ''
            debit_val = str(row[5]).strip() if pd.notna(row[5]) else ''
            credit_val = str(row[6]).strip() if pd.notna(row[6]) else ''
            
            # If we hit a new date row, save the old transaction and start a new one
            if date_val and date_val.lower() != 'nan' and 'date' not in date_val.lower():
                if current_tx:
                    # Finalize previous tx
                    note = extract_upi_note(current_tx["merchant"])
                    category = categorize_transaction(current_tx["merchant"], current_tx["amount"], current_tx["type"], note)
                    current_tx["note"] = note
                    current_tx["category"] = category
                    
                    if current_tx["type"] == "Credit":
                        pseudo_balance += current_tx["amount"]
                    else:
                        pseudo_balance -= current_tx["amount"]
                    current_tx["balance"] = round(pseudo_balance, 2)
                    
                    txs.append(current_tx)
                    
                amount = 0.0
                tx_type = "Debit"
                if debit_val and debit_val.lower() != 'nan':
                    cleaned = re.sub(r'[^\d.-]', '', debit_val)
                    if cleaned:
                        amount = float(cleaned)
                    tx_type = "Debit"
                elif credit_val and credit_val.lower() != 'nan':
                    cleaned = re.sub(r'[^\d.-]', '', credit_val)
                    if cleaned:
                        amount = float(cleaned)
                    tx_type = "Credit"
                    
                current_tx = {
                    "date": date_val,
                    "merchant": desc_val,
                    "amount": round(amount, 2),
                    "type": tx_type
                }
            else:
                # Append description from subsequent rows
                if current_tx and desc_val and desc_val.lower() != 'nan':
                    current_tx["merchant"] += " " + desc_val

        if current_tx:
            note = extract_upi_note(current_tx["merchant"])
            category = categorize_transaction(current_tx["merchant"], current_tx["amount"], current_tx["type"], note)
            current_tx["note"] = note
            current_tx["category"] = category
            if current_tx["type"] == "Credit":
                pseudo_balance += current_tx["amount"]
            else:
                pseudo_balance -= current_tx["amount"]
            current_tx["balance"] = round(pseudo_balance, 2)
            txs.append(current_tx)
            
        return txs

    df.columns = df.iloc[header_idx]
    df = df[header_idx+1:].reset_index(drop=True)
    df.columns = [str(c).strip().lower().replace('\n', ' ') for c in df.columns]
    
    date_col = next((c for c in df.columns if 'date' in c), None)
    desc_col = next((c for c in df.columns if 'particular' in c or 'description' in c or 'narration' in c or 'remark' in c), None)
    bal_col = next((c for c in df.columns if 'balance' in c), None)
    
    if not date_col or not desc_col or not bal_col:
        raise ValueError(f"Missing required columns. Found: {df.columns}")

    df = df.dropna(subset=[date_col, desc_col, bal_col])
    df[bal_col] = df[bal_col].apply(clean_amount)
    df = df.dropna(subset=[bal_col])
    
    prev_balance = None
    for _, row in df.iterrows():
        current_balance = row[bal_col]
        
        if prev_balance is None:
            prev_balance = current_balance
            continue
            
        delta = current_balance - prev_balance
        if abs(delta) < 0.01:
            prev_balance = current_balance
            continue

        tx_type = "Credit" if delta > 0 else "Debit"
        amount = abs(delta)
        
        desc = str(row[desc_col]).replace('\n', ' ')
        date_str = str(row[date_col]).replace('\n', ' ')
        
        note = extract_upi_note(desc)
        category = categorize_transaction(desc, amount, tx_type, note)
        
        transactions.append({
            "date": date_str,
            "merchant": desc[:50] + ("..." if len(desc) > 50 else ""),
            "note": note,
            "category": category,
            "type": tx_type,
            "amount": round(amount, 2),
            "balance": round(current_balance, 2)
        })
        
        prev_balance = current_balance

    return transactions
