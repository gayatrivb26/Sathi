<#
.SYNOPSIS
  Create (or upgrade) .env from .env.example, replacing every placeholder with a fresh value.
.DESCRIPTION
  __GENERATE__                       -> 48 hex chars (safe in URLs and connection strings)
  __GENERATE_BASE64__                -> 32 random bytes, base64
  __GENERATE_PASSWORD__              -> login password that satisfies the Sathi password policy
  __GENERATE_RSA_PRIVATE_PEM_B64__   -> base64 of a 2048-bit RSA private key, PKCS#8 PEM  } one key pair,
  __GENERATE_RSA_PUBLIC_PEM_B64__    -> base64 of the matching public key, SPKI PEM      } pure .NET (no openssl)

  (no switch)   create the file; refuses to overwrite an existing one
  -AddMissing   upgrade an existing file: keep every value, append only the variables that are missing
                (with fresh values), fill leftover placeholders, drop obsolete variables. Database
                passwords and other existing secrets are NOT rotated. A backup is kept next to the file.
  -Force        re-create the file from scratch (rotates every secret)
  Prints variable names only, never values. Works on Windows PowerShell 5.1 and PowerShell 7.
.EXAMPLE
  .\scripts\generate-secrets.ps1
  .\scripts\generate-secrets.ps1 -AddMissing
  .\scripts\generate-secrets.ps1 -Force -Output C:\temp\sathi.env
#>
[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$AddMissing,
    [string]$Output
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$template = Join-Path $root '.env.example'
if (-not $Output) { $Output = Join-Path $root '.env' }
$Output = [System.IO.Path]::GetFullPath($Output)

# Variables removed by a release; -AddMissing deletes them (and their stock comment line).
$obsoleteVars = @('SERVICE_TOKEN_SECRET')
$obsoleteComments = @('# HS256 key for the api/jobs -> ai-service token. >= 32 random bytes, base64.')
$privVar = 'SERVICE_TOKEN_PRIVATE_KEY_PEM_B64'
$pubVar = 'SERVICE_TOKEN_PUBLIC_KEY_PEM_B64'

if ($Force -and $AddMissing) { throw '-Force and -AddMissing are mutually exclusive' }
if ($AddMissing -and -not (Test-Path -LiteralPath $Output)) {
    Write-Host "$Output does not exist - creating it from scratch."
    $AddMissing = $false
}
if (-not $AddMissing -and (Test-Path -LiteralPath $Output) -and -not $Force) {
    Write-Error ("$Output already exists.`n" +
        "  Upgrade it (keeps existing secrets):  .\scripts\generate-secrets.ps1 -AddMissing`n" +
        "  Re-create it (rotates every secret; an existing Postgres volume keeps the OLD role passwords -`n" +
        "  run scripts\reset-db.ps1 afterwards):  .\scripts\generate-secrets.ps1 -Force")
}

# ------------------------------------------------------------------ random values
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
function Get-RandomBytes([int]$n) { $b = New-Object byte[] $n; $rng.GetBytes($b); return ,$b }
function ConvertTo-Hex([byte[]]$bytes) { ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant() }
function New-Hex { ConvertTo-Hex (Get-RandomBytes 24) }
function New-Base64 { [Convert]::ToBase64String((Get-RandomBytes 32)) }
function New-Password { 'Sa' + (ConvertTo-Hex (Get-RandomBytes 12)) + '!7' }

# ------------------------------------------------------------------ RSA key pair (minimal DER encoder)
# Windows PowerShell 5.1 (.NET Framework) has no ExportPkcs8PrivateKey/ExportSubjectPublicKeyInfo,
# so PKCS#8 and SPKI are DER-encoded here from RSAParameters (RFC 8017 A.1, RFC 5208, RFC 5280).
function Get-DerLength([int]$len) {
    if ($len -lt 0x80) { return ,([byte[]]@($len)) }
    $bytes = New-Object System.Collections.Generic.List[byte]
    while ($len -gt 0) { $bytes.Insert(0, [byte]($len -band 0xFF)); $len = $len -shr 8 }
    return ,([byte[]](@([byte](0x80 -bor $bytes.Count)) + $bytes.ToArray()))
}
function New-Der([byte]$tag, [byte[]]$content) {
    return ,([byte[]](@($tag) + (Get-DerLength $content.Length) + $content))
}
function New-DerInteger([byte[]]$unsignedBigEndian) {
    $i = 0
    while ($i -lt $unsignedBigEndian.Length - 1 -and $unsignedBigEndian[$i] -eq 0) { $i++ }
    $v = [byte[]]$unsignedBigEndian[$i..($unsignedBigEndian.Length - 1)]
    if ($v[0] -band 0x80) { $v = [byte[]](@([byte]0) + $v) }
    return New-Der 0x02 $v
}
function New-DerSequence([byte[][]]$parts) {
    $all = New-Object System.Collections.Generic.List[byte]
    foreach ($p in $parts) { $all.AddRange($p) }
    return New-Der 0x30 $all.ToArray()
}
function ConvertTo-Pem([string]$label, [byte[]]$der) {
    $b64 = [Convert]::ToBase64String($der)
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append("-----BEGIN $label-----`n")
    for ($i = 0; $i -lt $b64.Length; $i += 64) { [void]$sb.Append($b64.Substring($i, [Math]::Min(64, $b64.Length - $i))).Append("`n") }
    [void]$sb.Append("-----END $label-----`n")
    return $sb.ToString()
}
function New-RsaKeyPair {
    $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider 2048
    try {
        $p = $rsa.ExportParameters($true)
        # rsaEncryption OID 1.2.840.113549.1.1.1 + NULL parameters
        $algId = New-DerSequence @(
            [byte[]](0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01),
            [byte[]](0x05, 0x00))
        $pkcs1 = New-DerSequence @(
            (New-DerInteger ([byte[]]@(0))), (New-DerInteger $p.Modulus), (New-DerInteger $p.Exponent),
            (New-DerInteger $p.D), (New-DerInteger $p.P), (New-DerInteger $p.Q),
            (New-DerInteger $p.DP), (New-DerInteger $p.DQ), (New-DerInteger $p.InverseQ))
        $pkcs8 = New-DerSequence @((New-DerInteger ([byte[]]@(0))), $algId, (New-Der 0x04 $pkcs1))
        $rsaPublic = New-DerSequence @((New-DerInteger $p.Modulus), (New-DerInteger $p.Exponent))
        $spki = New-DerSequence @($algId, (New-Der 0x03 ([byte[]](@([byte]0) + $rsaPublic))))
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        return @{
            Private = [Convert]::ToBase64String($utf8.GetBytes((ConvertTo-Pem 'PRIVATE KEY' $pkcs8)))
            Public  = [Convert]::ToBase64String($utf8.GetBytes((ConvertTo-Pem 'PUBLIC KEY' $spki)))
        }
    }
    finally { $rsa.Dispose() }
}

$script:pair = $null
function Get-Value([string]$placeholder) {
    switch ($placeholder) {
        '__GENERATE_BASE64__' { return New-Base64 }
        '__GENERATE_PASSWORD__' { return New-Password }
        '__GENERATE_RSA_PRIVATE_PEM_B64__' { if (-not $script:pair) { $script:pair = New-RsaKeyPair }; return $script:pair.Private }
        '__GENERATE_RSA_PUBLIC_PEM_B64__' { if (-not $script:pair) { $script:pair = New-RsaKeyPair }; return $script:pair.Public }
        default { return New-Hex }
    }
}
function Test-Placeholder([string]$v) { return $v -cmatch '^__GENERATE[A-Z0-9_]*__$' }
$keyRe = '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$'

# UTF-8 without BOM and LF endings so Docker Compose and bash read it identically.
function Write-EnvFile([string]$path, [string[]]$lines) {
    $text = ($lines -join "`n") + "`n"
    $tmp = "$path.tmp"
    [System.IO.File]::WriteAllText($tmp, $text, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $path -Force
}

$templateLines = [System.IO.File]::ReadAllLines($template)

if (-not $AddMissing) {
    # ---------------------------------------------------------------- create
    $lines = foreach ($line in $templateLines) {
        if ($line -match $keyRe) {
            $k = $Matches[1]; $v = $Matches[2]
            if (Test-Placeholder $v) { "$k=$(Get-Value $v)" } else { $line }
        }
        else { $line }
    }
    Write-EnvFile $Output $lines
    Write-Host "Wrote $Output"
    $admin = ($lines | Where-Object { $_ -like 'SEED_ADMIN_EMAIL=*' }) -replace '^SEED_ADMIN_EMAIL=', ''
    Write-Host "Admin login: $admin / (see SEED_ADMIN_PASSWORD in .env)"
    Write-Host 'LLM mode: fake (set ANTHROPIC_API_KEY and LLM_PROVIDER=anthropic in .env for real Claude)'
    return
}

# -------------------------------------------------------------------- add missing
$current = [System.IO.File]::ReadAllLines($Output)
$existing = @{}
foreach ($line in $current) { if ($line -match $keyRe -and -not $existing.ContainsKey($Matches[1])) { $existing[$Matches[1]] = $Matches[2] } }

# The key pair is replaced as a unit whenever either half is missing, empty or still a placeholder.
$rotatePair = $false
foreach ($v in @($privVar, $pubVar)) {
    if (-not $existing.ContainsKey($v) -or [string]::IsNullOrEmpty($existing[$v]) -or (Test-Placeholder $existing[$v])) { $rotatePair = $true }
}
if ($rotatePair) { $script:pair = New-RsaKeyPair }

$added = New-Object System.Collections.Generic.List[string]
$filled = New-Object System.Collections.Generic.List[string]
$removed = New-Object System.Collections.Generic.List[string]
$out = New-Object System.Collections.Generic.List[string]

foreach ($line in $current) {
    if ($obsoleteComments -contains $line) { continue }
    if ($line -match $keyRe) {
        $k = $Matches[1]; $v = $Matches[2]
        if ($obsoleteVars -contains $k) { $removed.Add($k); continue }
        if ($rotatePair -and $k -eq $privVar) { $line = "$k=$($script:pair.Private)"; $filled.Add($k) }
        elseif ($rotatePair -and $k -eq $pubVar) { $line = "$k=$($script:pair.Public)"; $filled.Add($k) }
        elseif (Test-Placeholder $v) { $line = "$k=$(Get-Value $v)"; $filled.Add($k) }
    }
    $out.Add($line)
}

# Append template variables that are missing, each with the comment block that precedes it.
$comments = New-Object System.Collections.Generic.List[string]
$headerWritten = $false
foreach ($line in $templateLines) {
    if ($line.StartsWith('#')) { $comments.Add($line); continue }
    if ($line -match $keyRe) {
        $k = $Matches[1]; $v = $Matches[2]
        if (-not $existing.ContainsKey($k)) {
            if (-not $headerWritten) {
                $out.Add('')
                $out.Add("# ==== Added by scripts/generate-secrets -AddMissing on $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')) ====")
                $headerWritten = $true
            }
            foreach ($c in $comments) { $out.Add($c) }
            if ($k -eq $privVar) { $v = $script:pair.Private }
            elseif ($k -eq $pubVar) { $v = $script:pair.Public }
            elseif (Test-Placeholder $v) { $v = Get-Value $v }
            $out.Add("$k=$v")
            $added.Add($k)
        }
    }
    $comments.Clear()
}

if ($added.Count -eq 0 -and $filled.Count -eq 0 -and $removed.Count -eq 0) {
    Write-Host "$Output is up to date - nothing changed."
    return
}

$backup = "$Output.bak-$((Get-Date).ToString('yyyyMMddHHmmss'))"
Copy-Item -LiteralPath $Output -Destination $backup
Write-EnvFile $Output $out.ToArray()

Write-Host "Updated $Output (backup: $backup)"
if ($added.Count) { Write-Host "  added:     $($added -join ' ')" }
if ($filled.Count) { Write-Host "  generated: $($filled -join ' ')" }
if ($removed.Count) { Write-Host "  removed:   $($removed -join ' ') (obsolete)" }
Write-Host 'Existing values (database passwords, MinIO root, salts) were kept.'
Write-Host 'Apply with: docker compose up -d --build   (minio-init creates the storage users on start)'
