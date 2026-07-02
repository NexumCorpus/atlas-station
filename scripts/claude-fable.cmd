@echo off
rem Fable 5 in the CLI, fresh session in E:\ — the journal carries the thread.
rem (Resuming the full capstone transcript trips a cold-read policy classifier;
rem  the memory journal is the designed transport anyway.)
set API_TIMEOUT_MS=3000000
cd /d E:\
claude --model claude-fable-5
