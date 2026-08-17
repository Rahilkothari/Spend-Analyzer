import pandas as pd
import numpy as np

data = [
    ['', '', '', '', '', '', '', 'Branch Code: 4815'],
    ['', '', '', '', '', '', '', 'IFSC Code: CBIN0284815'],
    ['', '', '', '', '', '', '', 'Account Number: 5671444265'],
    ['', '', '', '', '', 'Product', 'Type:', 'HSS-GEN-PUB-IND-URBAN-INR'],
    ['DH', 'ANAVATH L', 'AKSHMAMMA', '', '', '', '', ''],
    ['HN', 'O5-104', '', '', '', '', '', ''],
    ['JA', 'NKUTHANDA', '', '', '', '', '', ''],
    ['VE', 'NKATADRIPA', 'LEM', '', '', '', '', ''],
    ['MI', 'RYALAGUDA', '', '', '', '', '', ''],
    ['Sta', 'tement Date :M', 'on Aug 17 15:21:46 I', 'ST 2026', '', '', '', ''],
    ['Em', 'ail:', '', '', '', '', '', ''],
    ['Cl', 'eared Balance: 1', '0982.540', '', '', '', '', ''],
    ['Dr', 'awing Power:', '', '', '', '', '', ''],
    ['ST', 'ATEMENT OF', 'ACCOUNT from 01', '/06/2026 to 16/08/20', '26', '', '', ''],
    ['', 'Post Date', 'Value Bran', 'ch Cheque', 'Transaction Description De', 'bit Cr', 'edit', ''],
    ['', '', 'Date Code', 'Number', '', '', '', ''],
    ['', '02/06/2026', '02/06/2026', '4815', 'UPI/RRN', '20', '', ''],
    ['', '', '', '', '725844958711/Payment from', '', '', ''],
    ['', '', '', '', 'PhonePe', '', '', ''],
    ['', '05/06/2026', '05/06/2026', '4815', 'UPI/RRN', '20', '', ''],
    ['', '', '', '', '362724436068/Payment from', '', '', ''],
    ['', '', '', '', 'PhonePe', '', '', ''],
    ['', '07/06/2026', '07/06/2026', '4815', 'UPI/RRN', '209', '', '']
]
# Simulate pandas missing values
for i in range(len(data)):
    for j in range(len(data[i])):
        if data[i][j] == '':
            data[i][j] = np.nan

df = pd.DataFrame(data)

header_idx = -1
is_cbin_format = False
for i in range(min(25, len(df))):
    # This is EXACTLY the logic in parser.py
    # But wait, pd.notna(x) checks for nan properly.
    row_str = " ".join(str(x).lower() for x in df.iloc[i].values if x)
    print(f"Row {i} str: '{row_str}'")
    if 'date' in row_str and ('balance' in row_str or 'bal' in row_str):
        header_idx = i
        break
    elif 'post date' in row_str and 'transaction description' in row_str:
        header_idx = i
        is_cbin_format = True
        break

print(f"Header Index: {header_idx}")
print(f"Is CBIN: {is_cbin_format}")
