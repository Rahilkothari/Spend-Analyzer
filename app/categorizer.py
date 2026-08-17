import re

# Keyword mappings for NOTE extraction
NOTE_CATEGORY_MAP = {
    "Food & Dining": ["dinner", "lunch", "snacks", "tiffin", "breakfast", "tea", "chai", "pizza", "burger", "dosa", "bhel", "wadapav", "icecream", "chaas", "samosa", "dabeli"],
    "Groceries": ["grocery", "dmart", "zepto", "blinkit", "dryfruits", "veg", "vegetables"],
    "Cab/Transport": ["auto", "petrol", "cab", "scooty", "uber", "ola", "rapido", "porter"],
    "Medical/Health": ["med", "medicine", "hospital", "clinic", "pharma"],
    "Movies/Outings": ["movie", "bookmyshow", "pvr", "trek", "outing"],
    "Personal Care/Sports": ["haircut", "salon", "badminton", "gym"]
}

# Keyword mappings for MERCHANT fallback
MERCHANT_CATEGORY_MAP = {
    "Investments": ["zerodha", "nse", "groww", "coin", "upstox", "mutual fund", "kuvera", "indmoney"],
    "Education/Loan EMI": ["education loan", "emi"],
    "Bills-Recharge/Internet": ["airtel", "jio", "air fiber", "recharge", "euronet", "vi", "vodafone", "broadband", "act fibernet", "electricity", "water", "bescom"],
    "Bills-Subscriptions": ["netflix", "google cloud", "spotify", "hotstar", "amazon prime", "steam"],
    "CC Payment": ["axis bank", "hdfc cc", "cc billpay", "credit card", "sbi card", "cred", "cheq"],
    "ATM Cash Withdrawal": ["atm", "cash wdl"],
    "Loan/Insurance Auto-debit": ["nach", "sip", "insurance"],
    "Rent": ["rent"],
    "Shopping": ["amazon", "flipkart", "myntra", "ajio", "nykaa", "shoppers stop", "zara", "h&m", "retail", "store", "mall", "reliance smart", "instamart"],
    "Food & Dining": ["swiggy", "zomato", "restaurant", "cafe", "baker", "mcdonalds", "kfc", "dominos", "coffee"],
    "Cab/Transport": ["irctc", "makemytrip", "flight", "hpcl", "iocl", "bpcl", "metro"]
}

NEEDS_WANTS_MAP = {
    "Groceries": "Need",
    "Cab/Transport": "Need",
    "Medical/Health": "Need",
    "Education/Loan EMI": "Need",
    "Bills-Recharge/Internet": "Need",
    "Rent": "Need",
    "Food & Dining": "Want",
    "Movies/Outings": "Want",
    "Personal Care/Sports": "Want",
    "Bills-Subscriptions": "Want",
    "Shopping": "Want",
    "Investments": "Save/Invest",
    "CC Payment": "Save/Invest",
    "ATM Cash Withdrawal": "Neutral",
    "Loan/Insurance Auto-debit": "Save/Invest",
    "Income": "Neutral",
    "Family/Self Transfer": "Neutral",
    "Ignored/Refund": "Neutral",
    "Misc/Other": "Neutral"
}

def extract_upi_note(description: str) -> str:
    """
    Extracts the user's UPI note from the transaction description.
    UPI format: UPI/<merchant>/<upi-id>/<NOTE>/<bank>/<ref>
    """
    desc = description.strip()
    
    if "UPI" in desc.upper() or "upi" in desc.lower():
        # Split by /
        parts = desc.split('/')
        if len(parts) >= 4:
            note = parts[3].strip()
            # Exclude bad notes
            bad_notes = {"upi", "na", "no remarks", ""}
            if note.lower() not in bad_notes and not note.lower().endswith("bank"):
                return note
                
        # Fallback to '-' split just in case it's a different format
        parts_dash = desc.split('-')
        if len(parts_dash) > 3:
            note = parts_dash[-1].strip()
            if not note.isnumeric() and len(note) > 2:
                bad_notes = {"upi", "na", "no remarks", ""}
                if note.lower() not in bad_notes and not note.lower().endswith("bank"):
                    return note
                    
    return ""

import json
import os

USER_MAPPINGS_FILE = "user_mappings.json"
_user_mappings = {}

def load_user_mappings():
    global _user_mappings
    if os.path.exists(USER_MAPPINGS_FILE):
        try:
            with open(USER_MAPPINGS_FILE, "r") as f:
                _user_mappings = json.load(f)
        except:
            pass

# Load once on startup
load_user_mappings()

def categorize_transaction(description: str, amount: float, tx_type: str, note: str = "") -> str:
    """
    Categorizes transaction checking user overrides, then Note, then Merchant name.
    """
    desc_lower = description.lower()
    note_lower = note.lower()

    # 0. User Overrides (Absolute Priority)
    for merchant_key, mapped_category in _user_mappings.items():
        if merchant_key.lower() in desc_lower:
            return mapped_category

    if tx_type == "Credit":
        if "salary" in desc_lower or "sal" in desc_lower:
            return "Income"
        if "refund" in desc_lower or "reversal" in desc_lower:
            return "Misc/Other" # Or Refund, but user didn't specify. Keep neutral.
        if "interest" in desc_lower:
            return "Income"
        return "Income"

    # Family / Self Transfers explicit tagging
    if "to family" in desc_lower or "to self" in desc_lower or "to self" in note_lower or "to family" in note_lower:
        return "Family/Self Transfer"

    # 1. Note Extraction Check (Primary Signal)
    if note_lower:
        for category, keywords in NOTE_CATEGORY_MAP.items():
            if any(kw in note_lower for kw in keywords):
                return category

    # 2. Merchant Fallback Check
    if amount > 5000 and any(kw in desc_lower for kw in MERCHANT_CATEGORY_MAP["CC Payment"]):
        return "CC Payment"

    for category, keywords in MERCHANT_CATEGORY_MAP.items():
        if any(kw in desc_lower for kw in keywords):
            return category
            
    return "Misc/Other"

def get_needs_wants_mapping(category: str) -> str:
    return NEEDS_WANTS_MAP.get(category, "Neutral")
