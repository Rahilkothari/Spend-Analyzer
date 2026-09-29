@echo off
venv\Scripts\pyinstaller.exe --noconfirm --onedir --windowed --name "SpendAnalyzer" --add-data "static;static" --hidden-import uvicorn --hidden-import fastapi --hidden-import pydantic --hidden-import starlette run_app.py
