@echo off
title Spend Analyzer - Local Server
echo =========================================
echo       Starting Spend Analyzer...
echo =========================================
echo.

:: Check if the virtual environment exists
if not exist "venv\Scripts\activate.bat" (
    echo Error: Virtual environment not found in the 'venv' folder.
    echo Please run the installation steps in the README.
    pause
    exit /b
)

:: Start the FastAPI server in a new window so it runs in the background
start "Spend Analyzer Server" cmd /k "venv\Scripts\activate.bat && uvicorn app.main:app --port 8000"

:: Wait for 3 seconds to give the server time to boot up
timeout /t 3 /nobreak > nul

:: Open the default web browser to the local dashboard
echo Opening dashboard in your web browser...
start http://127.0.0.1:8000

echo.
echo =========================================
echo  Dashboard is live! 
echo  (You can close this black window, but leave the 'Spend Analyzer Server' window open while using the app)
echo =========================================
timeout /t 5 > nul
