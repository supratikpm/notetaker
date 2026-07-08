@echo off
title Notetaker Backend
cd /d "C:\Projects\Notetaker\backend"

:: Kill any stale instance on port 8000
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8000 " ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo Starting Notetaker backend...
echo Keep this window open during your meetings.
echo.
C:\Users\SUPRATIK\AppData\Local\Programs\Python\Python311\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
pause
