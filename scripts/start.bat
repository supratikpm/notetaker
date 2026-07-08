@echo off
echo Starting Notetaker backend...
cd /d %~dp0..\backend
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
