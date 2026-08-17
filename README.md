# 📊 Personal Finance Dashboard

A lightning-fast, privacy-first personal finance dashboard that turns your raw bank statements into beautiful, actionable insights. Built with a lightweight Python/FastAPI backend and a pure HTML/JS frontend—no complex databases or heavy frameworks required.

![Dashboard Preview](https://via.placeholder.com/1200x600.png?text=Dashboard+Preview)

## ✨ Features

- **Multi-Format Uploads**: Simply drag and drop your bank statements. Supports PDF, Excel (`.xlsx`, `.xls`), and CSV formats out of the box.
- **Smart Auto-Categorization**: An intelligent categorization engine maps your merchants to standardized buckets (Food, Utilities, Travel, etc.) and tags them as "Needs" or "Wants".
- **Dynamic Charting**: Fully interactive charts powered by Chart.js.
  - 📈 Net Savings vs Spend vs Income over time.
  - 📊 Stacked Category Breakdown (Top 6 + Other).
- **Interactive Transaction Table**: 
  - **Live Edits**: Click any category or month to instantly reassign it. Changes are saved locally and persist across re-uploads!
  - **Calculator Tray**: Select individual transactions using the `+` button to instantly see their net sum in a sticky tray—perfect for auditing specific events.
- **Actionable Insights**: See your Top 15 highest transactions, most frequent merchants, and auto-generated "Month Verdicts" summarizing your financial health.
- **Privacy First**: Everything runs locally on your machine. Your financial data never leaves your computer.

## 🚀 Quick Start

### 1. Prerequisites
Ensure you have Python 3.8+ installed on your machine.

### 2. Installation
Clone the repository and install the required dependencies:

```bash
git clone https://github.com/yourusername/budget-analysis.git
cd budget-analysis

# Create and activate a virtual environment (optional but recommended)
python -m venv venv
# On Windows:
venv\Scripts\activate
# On Mac/Linux:
source venv/bin/activate

# Install requirements
pip install -r requirements.txt
```

### 3. Run the Server
Start the FastAPI backend server:

```bash
uvicorn app.main:app --port 8000 --reload
```

### 4. Open the Dashboard
Open your web browser and navigate to:
[http://127.0.0.1:8000](http://127.0.0.1:8000)

## 📁 Project Structure

```text
budget-analysis/
├── app/
│   ├── main.py           # FastAPI backend & aggregation engine
│   ├── parser.py         # PDF & Excel bank statement parsers
│   └── categorizer.py    # Merchant classification & Need/Want logic
├── static/
│   ├── index.html        # Frontend dashboard UI
│   ├── style.css         # Custom styling (Glassmorphism, Dark mode)
│   └── app.js            # Frontend logic & Chart.js integration
├── requirements.txt      # Python dependencies
└── README.md             
```

## 🛠️ Built With
- **Backend**: Python, [FastAPI](https://fastapi.tiangolo.com/), Pandas, pdfplumber
- **Frontend**: Vanilla HTML/JS/CSS, [Chart.js](https://www.chartjs.org/)

## 📝 Customization

- **Custom Categories**: The backend engine saves your manual overrides into `user_mappings.json` and `tx_overrides.json` in the root folder. You can directly edit these files to permanently remap specific merchants or specific transactions.
- **Parser Logic**: If your bank uses a highly unique format, you can easily add a custom extraction block in `app/parser.py`.

## 🤝 Contributing
Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/yourusername/budget-analysis/issues).
