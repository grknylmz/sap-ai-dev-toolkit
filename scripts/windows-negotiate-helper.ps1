# Windows Integrated Authentication helper for sap-ai-dev-toolkit.
# Reads one JSON object from stdin with: url, challenge, mechanism.
# Writes only the base64 Negotiate token to stdout.
# Errors are written to stderr and exit non-zero.

$ErrorActionPreference = 'Stop'

$sspiSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class SapAiDevSspiNegotiate
{
    const int SECPKG_CRED_OUTBOUND = 2;
    const int SECBUFFER_VERSION = 0;
    const int SECBUFFER_TOKEN = 2;
    const int SECURITY_NATIVE_DREP = 0x10;
    const int SEC_E_OK = 0;
    const int SEC_I_CONTINUE_NEEDED = 0x00090312;

    [StructLayout(LayoutKind.Sequential)]
    struct SecHandle
    {
        public IntPtr dwLower;
        public IntPtr dwUpper;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct SecBuffer
    {
        public int cbBuffer;
        public int BufferType;
        public IntPtr pvBuffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct SecBufferDesc
    {
        public int ulVersion;
        public int cBuffers;
        public IntPtr pBuffers;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct SECURITY_INTEGER
    {
        public uint LowPart;
        public int HighPart;
    }

    [DllImport("secur32.dll", CharSet = CharSet.Unicode, SetLastError = false)]
    static extern int AcquireCredentialsHandle(
        string pszPrincipal,
        string pszPackage,
        int fCredentialUse,
        IntPtr pvLogonID,
        IntPtr pAuthData,
        IntPtr pGetKeyFn,
        IntPtr pvGetKeyArgument,
        out SecHandle phCredential,
        out SECURITY_INTEGER ptsExpiry);

    [DllImport("secur32.dll", CharSet = CharSet.Unicode, SetLastError = false)]
    static extern int InitializeSecurityContext(
        ref SecHandle phCredential,
        IntPtr phContext,
        string pszTargetName,
        int fContextReq,
        int Reserved1,
        int TargetDataRep,
        IntPtr pInput,
        int Reserved2,
        out SecHandle phNewContext,
        IntPtr pOutput,
        out int pfContextAttr,
        out SECURITY_INTEGER ptsExpiry);

    [DllImport("secur32.dll", SetLastError = false)]
    static extern int FreeCredentialsHandle(ref SecHandle phCredential);

    [DllImport("secur32.dll", SetLastError = false)]
    static extern int DeleteSecurityContext(ref SecHandle phContext);

    static void Check(int status, string operation)
    {
        if (status == SEC_E_OK || status == SEC_I_CONTINUE_NEEDED) return;
        throw new Win32Exception(status, operation + " failed with SSPI status 0x" + status.ToString("X8"));
    }

    static IntPtr BufferDesc(byte[] token, out IntPtr tokenMemory, out IntPtr bufferMemory)
    {
        tokenMemory = IntPtr.Zero;
        SecBuffer buffer = new SecBuffer();
        buffer.BufferType = SECBUFFER_TOKEN;
        if (token != null && token.Length > 0)
        {
            tokenMemory = Marshal.AllocHGlobal(token.Length);
            Marshal.Copy(token, 0, tokenMemory, token.Length);
            buffer.cbBuffer = token.Length;
            buffer.pvBuffer = tokenMemory;
        }
        bufferMemory = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecBuffer)));
        Marshal.StructureToPtr(buffer, bufferMemory, false);
        SecBufferDesc desc = new SecBufferDesc();
        desc.ulVersion = SECBUFFER_VERSION;
        desc.cBuffers = 1;
        desc.pBuffers = bufferMemory;
        IntPtr descMemory = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecBufferDesc)));
        Marshal.StructureToPtr(desc, descMemory, false);
        return descMemory;
    }

    static void FreeDesc(IntPtr descMemory, IntPtr tokenMemory, IntPtr bufferMemory)
    {
        if (descMemory != IntPtr.Zero) Marshal.FreeHGlobal(descMemory);
        if (bufferMemory != IntPtr.Zero) Marshal.FreeHGlobal(bufferMemory);
        if (tokenMemory != IntPtr.Zero) Marshal.FreeHGlobal(tokenMemory);
    }

    public static string CreateToken(string targetName, string incomingBase64)
    {
        SecHandle credential;
        SECURITY_INTEGER expiry;
        int status = AcquireCredentialsHandle(null, "Negotiate", SECPKG_CRED_OUTBOUND, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out credential, out expiry);
        Check(status, "AcquireCredentialsHandle");

        SecHandle context = new SecHandle();
        IntPtr inputDesc = IntPtr.Zero, inputToken = IntPtr.Zero, inputBuffer = IntPtr.Zero;
        IntPtr outputDesc = IntPtr.Zero, outputToken = IntPtr.Zero, outputBuffer = IntPtr.Zero;
        try
        {
            byte[] incoming = null;
            if (!String.IsNullOrWhiteSpace(incomingBase64)) incoming = Convert.FromBase64String(incomingBase64);
            if (incoming != null && incoming.Length > 0) inputDesc = BufferDesc(incoming, out inputToken, out inputBuffer);

            outputDesc = BufferDesc(new byte[12288], out outputToken, out outputBuffer);
            int attrs;
            status = InitializeSecurityContext(ref credential, IntPtr.Zero, targetName, 0, 0, SECURITY_NATIVE_DREP, inputDesc, 0, out context, outputDesc, out attrs, out expiry);
            Check(status, "InitializeSecurityContext");

            SecBuffer outBuffer = (SecBuffer) Marshal.PtrToStructure(outputBuffer, typeof(SecBuffer));
            if (outBuffer.cbBuffer <= 0 || outBuffer.pvBuffer == IntPtr.Zero) throw new Exception("SSPI returned an empty Negotiate token.");
            byte[] bytes = new byte[outBuffer.cbBuffer];
            Marshal.Copy(outBuffer.pvBuffer, bytes, 0, bytes.Length);
            return Convert.ToBase64String(bytes);
        }
        finally
        {
            FreeDesc(inputDesc, inputToken, inputBuffer);
            FreeDesc(outputDesc, outputToken, outputBuffer);
            DeleteSecurityContext(ref context);
            FreeCredentialsHandle(ref credential);
        }
    }
}
'@

try {
  $raw = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($raw)) { throw 'Missing helper request on stdin.' }
  $request = $raw | ConvertFrom-Json
  if (-not $request.url) { throw 'Missing target URL.' }

  $uri = [Uri] [string] $request.url
  if ($uri.Scheme -ne 'http' -and $uri.Scheme -ne 'https') { throw 'Target URL must use HTTP or HTTPS.' }
  if ($uri.UserInfo) { throw 'Target URL must not contain user information.' }

  Add-Type -TypeDefinition $sspiSource -Language CSharp

  $incoming = $null
  $challenge = [string] $request.challenge
  if ($challenge -match '(?i)Negotiate\s+([^,\s]+)') { $incoming = $Matches[1] }
  $targetName = 'HTTP/' + $uri.DnsSafeHost
  $token = [SapAiDevSspiNegotiate]::CreateToken($targetName, $incoming)
  if ([string]::IsNullOrWhiteSpace($token)) { throw 'Negotiate token generation returned an empty token.' }
  [Console]::Out.WriteLine($token.Trim())
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
