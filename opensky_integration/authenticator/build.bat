@echo off
pip install -r requirements.txt
pyinstaller --onefile --windowed --name "OpenSkyAuthenticator" opensky_auth.py
echo.
echo Done! Executable is in dist\OpenSkyAuthenticator.exe
pause
