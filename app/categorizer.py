import re
import os
import json
from pathlib import Path

# Keyword mappings for NOTE extraction
NOTE_CATEGORY_MAP = {
    "Food & Dining": ["dinner", "lunch", "snacks", "tiffin", "breakfast", "tea", "chai", "pizza", "burger", "dosa", "bhel", "wadapav", "icecream", "chaas", "samosa", "dabeli"],
    "Groceries/Home": ["grocery", "dmart", "dryfruits", "veg", "vegetables", "misc"],
    "Cab/Transport": ["auto", "petrol", "cab", "scooty", "uber", "ola", "rapido", "porter"],
    "Train Tickets": ["train", "irctc"],
    "Medical/Health": ["med", "medicine", "hospital", "clinic", "pharma"],
    "Fun & Entertainment": ["movie", "bookmyshow", "pvr", "trek", "outing", "bowling", "arcade", "smaash", "game", "gaming", "ticket", "event"],
    "Personal Care": ["haircut", "salon", "spa", "cosmetics"],
    "Sports/Fitness": ["badminton", "gym", "sports", "turf"],
    "Other": ["other"]
}

# Keyword mappings for MERCHANT fallback
MERCHANT_CATEGORY_MAP = {
    "Investments": ["zerodha", "nse", "groww", "coin", "upstox", "mutual fund", "kuvera", "indmoney"],
    "Education/Loan EMI": ["education loan", "emi"],
    "Bills-Recharge/Internet": ["airtel", "jio", "air fiber", "recharge", "euronet", "vi", "vodafone", "broadband", "act fibernet", "electricity", "water", "bescom"],
    "Bills-Subscriptions": ["netflix", "google cloud", "spotify", "hotstar", "amazon prime", "steam"],
    "ATM Cash Withdrawal": ["atm", "cash wdl"],
    "Loan/Insurance Auto-debit": ["nach", "sip", "insurance"],
    "Rent": ["rent"],
    "Shopping": ["amazon", "flipkart", "myntra", "ajio", "nykaa", "shoppers stop", "zara", "h&m", "retail", "store", "mall", "reliance smart", "instamart"],
    "Food & Dining": ["swiggy", "zomato", "restaurant", "cafe", "baker", "mcdonalds", "kfc", "dominos", "coffee"],
    "Cab/Transport": ["makemytrip", "flight", "hpcl", "iocl", "bpcl", "metro"],
    "Train Tickets": ["irctc"],
    "Fun & Entertainment": ["bookmyshow", "pvr", "inox", "smaash", "bowling", "playstation", "arcade"],
    "CC Payment": ["axis bank", "hdfc cc", "cc billpay", "credit card", "sbi card", "cred", "cheq"]
}

NEEDS_WANTS_MAP = {
    "Groceries/Home": "Need",
    "Cab/Transport": "Need",
    "Train Tickets": "Need",
    "Medical/Health": "Need",
    "Education/Loan EMI": "Need",
    "Bills-Recharge/Internet": "Need",
    "Rent": "Need",
    "Food & Dining": "Want",
    "Fun & Entertainment": "Want",
    "Personal Care": "Want",
    "Sports/Fitness": "Want",
    "Bills-Subscriptions": "Want",
    "Shopping": "Want",
    "Investments": "Save/Invest",
    "CC Payment": "Save/Invest",
    "ATM Cash Withdrawal": "Neutral",
    "Loan/Insurance Auto-debit": "Save/Invest",
    "Income": "Neutral",
    "Family/Self Transfer": "Neutral",
    "Ignored/Refund": "Neutral",
    "Other": "Neutral"
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

DATA_DIR = Path.home() / ".spend_analyzer"
MAPPING_FILE = DATA_DIR / "user_mappings.json"
CUSTOM_RULES_FILE = DATA_DIR / "custom_rules.json"

_user_mappings = {}
_custom_rules = []

def load_user_mappings():
    global _user_mappings
    if os.path.exists(MAPPING_FILE):
        try:
            with open(MAPPING_FILE, "r") as f:
                _user_mappings = json.load(f)
        except:
            pass

def load_custom_rules():
    global _custom_rules
    if not os.path.exists(CUSTOM_RULES_FILE):
        # Create default personal rules (can be cleared by other users)
        default_rules = [
            {"type": "exact_amount", "keyword": "papa", "amount": 15000.0, "category": "Rent"},
            {"type": "keyword", "keyword": "mom", "category": "Family/Self Transfer"},
            {"type": "keyword", "keyword": "zepto", "category": "Groceries/Home"},
            {"type": "keyword", "keyword": "blinkit", "category": "Groceries/Home"},
            {"type": "keyword", "keyword": "dmart", "category": "Shopping"},
            {"type": "keyword", "keyword": "zomato", "category": "Food & Dining"},
            {"type": "keyword", "keyword": "swiggy", "category": "Food & Dining"}
        ]
        os.makedirs(os.path.dirname(CUSTOM_RULES_FILE), exist_ok=True)
        try:
            with open(CUSTOM_RULES_FILE, "w") as f:
                json.dump(default_rules, f, indent=4)
        except:
            pass
            
    if os.path.exists(CUSTOM_RULES_FILE):
        try:
            with open(CUSTOM_RULES_FILE, "r") as f:
                _custom_rules = json.load(f)
        except:
            _custom_rules = []

# Load once on startup
load_user_mappings()
load_custom_rules()

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
        if "salary" in desc_lower or "sal " in desc_lower or "interest" in desc_lower or "cashback" in desc_lower or "dividend" in desc_lower:
            return "Income"
        if "refund" in desc_lower or "reversal" in desc_lower or "split" in desc_lower or "share" in desc_lower:
            return "Ignored/Refund"
            
        # The user realized that finding individual friend reimbursements is too tedious.
        # Automatically mark UPI credits as Ignored/Refund so they only have to use the Split button on the debits.
        if "upi" in desc_lower:
            return "Ignored/Refund"
            
        return "Income"

    # Custom Explicit Rules from File
    for rule in _custom_rules:
        rtype = rule.get("type")
        rkw = rule.get("keyword", "").lower()
        rcat = rule.get("category", "Other")
        if rtype == "keyword":
            if rkw in desc_lower:
                return rcat
        elif rtype == "exact_amount":
            ramt = float(rule.get("amount", 0))
            if rkw in desc_lower and abs(amount - ramt) < 0.01:
                return rcat
    # Family / Self Transfers explicit tagging
    if "to family" in desc_lower or "to self" in desc_lower or "to self" in note_lower or "to family" in note_lower:
        return "Family/Self Transfer"

    # 1. Note Extraction Check (Primary Signal)
    if note_lower:
        for category, keywords in NOTE_CATEGORY_MAP.items():
            if any(kw in note_lower for kw in keywords):
                return category
        for category, keywords in MERCHANT_CATEGORY_MAP.items():
            if any(kw in note_lower for kw in keywords):
                return category

    # 2. Merchant Fallback Check

    for category, keywords in MERCHANT_CATEGORY_MAP.items():
        if any(kw in desc_lower for kw in keywords):
            return category
            
    return "Other"

def get_needs_wants_mapping(category: str) -> str:
    return NEEDS_WANTS_MAP.get(category, "Neutral")
