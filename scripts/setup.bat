@echo off
echo ============================================
echo  Notetaker — Setup
echo ============================================

echo.
echo [1/3] Installing Python backend dependencies...
cd /d %~dp0..\backend
pip install -r requirements.txt
if errorlevel 1 (
    echo ERROR: pip install failed. Make sure Python 3.10+ is installed.
    pause
    exit /b 1
)

echo.
echo [2/3] Installing Node extension dependencies...
cd /d %~dp0..\extension
call npm install
if errorlevel 1 (
    echo ERROR: npm install failed. Make sure Node.js 18+ is installed.
    pause
    exit /b 1
)

echo.
echo [3/3] Building Chrome extension...
call npm run build
if errorlevel 1 (
    echo ERROR: webpack build failed.
    pause
    exit /b 1
)

echo.
echo ============================================
echo  Setup complete!
echo.
echo  Next steps:
echo  1. Copy backend\.env.example to backend\.env
echo     and fill in your NVIDIA_NIM_API_KEY and HUGGINGFACE_TOKEN
echo  2. Download credentials.json from Google Cloud Console
echo     and place it in backend\credentials.json
echo  3. Run: scripts\start.bat
echo  4. Load extension\dist\ as unpacked extension in Chrome
echo  5. Open extension Options and connect your Gmail
echo ============================================
pause
