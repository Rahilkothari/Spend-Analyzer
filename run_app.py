import uvicorn
import multiprocessing
import threading
import webbrowser
import time
import sys
import io
import traceback
from pathlib import Path

# Redirect stdout/stderr to a file so we can see errors
log_file = Path.home() / ".spend_analyzer" / "app_debug.log"
log_file.parent.mkdir(exist_ok=True)
sys.stdout = open(log_file, "w", encoding="utf-8")
sys.stderr = sys.stdout

def open_browser():
    time.sleep(3)  # Wait for uvicorn to boot up
    try:
        webbrowser.open('http://127.0.0.1:8501')
    except Exception as e:
        print(f"Failed to open browser: {e}")

if __name__ == '__main__':
    # Required for multiprocessing in PyInstaller executables
    multiprocessing.freeze_support()
    
    # Start the browser thread
    threading.Thread(target=open_browser, daemon=True).start()
    
    # Import the FastAPI app object directly so PyInstaller bundles it
    from app.main import app as fastapi_app
    
    # Run the FastAPI app
    print("Starting Spend Analyzer Server...")
    uvicorn.run(fastapi_app, host="127.0.0.1", port=8501)

