Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)
$projectPath = (Get-Location).Path

Clear-Host
Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "   OLCAGROUP - Claude MCP Installer"      -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Proyecto: $projectPath" -ForegroundColor Yellow
Write-Host ""

# --- Seleccionar cuenta ---
Write-Host "Cuentas disponibles:" -ForegroundColor White
Write-Host "  [1] Empresarial"    -ForegroundColor DarkCyan
Write-Host "  [2] Personal"       -ForegroundColor DarkCyan
Write-Host ""
$cuentaOpcion = Read-Host "Selecciona cuenta GitHub (1 o 2)"

if ($cuentaOpcion -eq "1") {
    $githubToken = [System.Environment]::GetEnvironmentVariable("GITHUB_TOKEN_EMPRESA", "User")
    $cuentaNombre = "Empresarial"
} else {
    $githubToken = [System.Environment]::GetEnvironmentVariable("GITHUB_TOKEN_PERSONAL", "User")
    $cuentaNombre = "Personal"
}

if ([string]::IsNullOrWhiteSpace($githubToken)) {
    Write-Host ""
    Write-Host "ERROR: No se encontro el token para la cuenta $cuentaNombre." -ForegroundColor Red
    Write-Host ""
    pause
    exit 1
}

Write-Host ""
Write-Host "Cuenta: $cuentaNombre - Token OK" -ForegroundColor Green

# --- Limpiar TODOS los MCPs existentes ---
Write-Host ""
Write-Host "Limpiando MCPs existentes..." -ForegroundColor Yellow
Write-Host ""

$mcpsToRemove = @("memory","shadcn","context7","sequential-thinking","playwright","github","filesystem","serena","sentry","postgres","stripe","linear","notion","slack","redis","mongodb","docker","kubernetes")

foreach ($mcp in $mcpsToRemove) {
    claude mcp remove $mcp -s user 2>&1 | Out-Null
    claude mcp remove $mcp 2>&1 | Out-Null
}

Write-Host "Limpieza completada." -ForegroundColor Green

# --- Instalar CLIs ---
Write-Host ""
Write-Host "Instalando CLIs..." -ForegroundColor Green
Write-Host ""

Write-Host "[CLI 1/3] Git..." -ForegroundColor DarkCyan
winget install --id Git.Git -e --silent 2>&1 | Out-Null

Write-Host "[CLI 2/3] uv..." -ForegroundColor DarkCyan
winget install --id astral-sh.uv -e --silent 2>&1 | Out-Null

Write-Host "[CLI 3/3] Vercel..." -ForegroundColor DarkCyan
npm install -g vercel 2>&1 | Out-Null

Write-Host "CLIs listos." -ForegroundColor Green

# --- MCPs GLOBALES ---
Write-Host ""
Write-Host "Registrando MCPs globales..." -ForegroundColor Green
Write-Host ""

Write-Host "[1/6] Memory..." -ForegroundColor DarkCyan
claude mcp add -s user memory -- npx -y @modelcontextprotocol/server-memory

Write-Host "[2/6] Shadcn..." -ForegroundColor DarkCyan
claude mcp add -s user shadcn -- npx -y shadcn@latest mcp

Write-Host "[3/6] Context7..." -ForegroundColor DarkCyan
claude mcp add -s user context7 -- npx -y @upstash/context7-mcp

Write-Host "[4/6] Sequential Thinking..." -ForegroundColor DarkCyan
claude mcp add -s user sequential-thinking -- npx -y @modelcontextprotocol/server-sequential-thinking

Write-Host "[5/6] Playwright..." -ForegroundColor DarkCyan
claude mcp add -s user playwright -- npx -y @playwright/mcp@latest

Write-Host "[6/6] GitHub ($cuentaNombre)..." -ForegroundColor DarkCyan
claude mcp add -s user github -e "GITHUB_TOKEN=$githubToken" -- npx -y @modelcontextprotocol/server-github

# --- MCPs LOCALES ---
Write-Host ""
Write-Host "Registrando MCPs locales del proyecto..." -ForegroundColor Green
Write-Host ""

Write-Host "[1/2] Filesystem..." -ForegroundColor DarkCyan
claude mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem "$projectPath"

Write-Host "[2/2] Serena..." -ForegroundColor DarkCyan
claude mcp add serena -- uvx --from git+https://github.com/oraios/serena serena start-mcp-server --project "$projectPath"

# --- Resumen ---
Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "   Instalacion completada!"               -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "MCPs GLOBALES:" -ForegroundColor White
Write-Host "  [OK] memory"              -ForegroundColor Green
Write-Host "  [OK] shadcn"              -ForegroundColor Green
Write-Host "  [OK] context7"            -ForegroundColor Green
Write-Host "  [OK] sequential-thinking" -ForegroundColor Green
Write-Host "  [OK] playwright"          -ForegroundColor Green
Write-Host "  [OK] github ($cuentaNombre)" -ForegroundColor Green
Write-Host ""
Write-Host "MCPs LOCALES:" -ForegroundColor White
Write-Host "  [OK] filesystem ($projectPath)" -ForegroundColor Green
Write-Host "  [OK] serena     ($projectPath)" -ForegroundColor Green
Write-Host ""
Write-Host "CLIs:" -ForegroundColor White
Write-Host "  [OK] git"     -ForegroundColor Green
Write-Host "  [OK] uv/uvx"  -ForegroundColor Green
Write-Host "  [OK] vercel"  -ForegroundColor Green
Write-Host ""
Write-Host "Verifica con: claude mcp list" -ForegroundColor Yellow
Write-Host ""
pause
