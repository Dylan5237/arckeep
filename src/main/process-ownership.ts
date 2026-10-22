import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ShellPlan } from './tool-launch.js'

type WindowsRelayPlan = Pick<ShellPlan, 'file' | 'args' | 'windowsVerbatimArguments'>

interface RelayCache {
  directory: string
  source: string
  bootstrap: string
  executable: string
}

interface RelayControl {
  cancellationSent: boolean
  failureMarkerSeen: boolean
  diagnosticTail: string
}

const windowsJobRelays = new WeakMap<ChildProcess, RelayControl>()
let relayCache: RelayCache | undefined
let relayPreparation: Promise<boolean> | undefined

/**
 * Compiles the relay once per app run, outside any command's timeout. Production
 * startup calls this; commands that arrive before it finishes use a direct,
 * hidden spawn instead of compiling once per command.
 */
export function prepareWindowsJobRelay(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  relayPreparation ??= prepareWindowsJobRelayOnce(env)
  return relayPreparation
}

async function prepareWindowsJobRelayOnce(env: NodeJS.ProcessEnv): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const cache = getRelayCache()
  if (isReadyExecutable(cache.executable)) return true
  try {
    await runPrepareBootstrap(cache, env)
    return isReadyExecutable(cache.executable)
  } catch (error) {
    console.error(`Arckeep relay 准备失败，后续命令改为直接启动：${error instanceof Error ? error.message : String(error)}`)
    return false
  } finally {
    cleanupStaging(cache)
  }
}

const PREPARE_SPEC = 'PREPARE'
const PREPARE_TIMEOUT_MS = 60_000

function runPrepareBootstrap(cache: RelayCache, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(windowsPowerShell(env), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', cache.bootstrap
    ], {
      cwd: cache.directory,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe']
    })
    let stderr = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      finish(new Error('relay 编译超时'))
    }, PREPARE_TIMEOUT_MS)
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-512)
    })
    child.once('error', error => finish(error instanceof Error ? error : new Error(String(error))))
    child.once('close', code => {
      if (code === 0) finish()
      else finish(new Error(`relay 编译进程退出 ${code}${stderr.trim() ? `：${stderr.trim()}` : ''}`))
    })
    child.stdin?.on('error', () => {})
    child.stdin?.write(`${PREPARE_SPEC}\n`)
  })
}

/** Always-hidden direct launch used before the relay is ready or after it fails. */
function spawnDirect(plan: WindowsRelayPlan, cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(plan.file, plan.args, {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: plan.windowsVerbatimArguments ?? false,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function cleanupStaging(cache: RelayCache): void {
  let names: string[]
  try { names = readdirSync(cache.directory) } catch { return }
  for (const name of names) {
    if (!name.startsWith('relay-') && !name.startsWith('publish-')) continue
    try { rmSync(path.join(cache.directory, name), { force: true }) } catch { /* best effort */ }
  }
}

/**
 * Starts a command behind a Windows Job Object owner. The first launch compiles
 * the small .NET Framework relay in a private temp directory; later launches
 * start that executable directly. Only the static relay source is written to
 * disk. The command specification travels through the relay's stdin pipe.
 */
export function spawnWindowsJobRelay(
  plan: WindowsRelayPlan,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  parentPid: number = process.pid
): ChildProcess {
  const cache = getRelayCache()
  const compiled = isReadyExecutable(cache.executable)
  if (!compiled && relayPreparation !== undefined) {
    // Production startup already started the one background compile. Never
    // compile per command: run directly until (or unless) the relay is ready.
    return spawnDirect(plan, cwd, env)
  }
  const command = compiled
    ? { file: cache.executable, args: [] }
    : {
      file: windowsPowerShell(env),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', cache.bootstrap]
    }
  const options: SpawnOptions = {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: false,
    stdio: ['pipe', 'pipe', 'pipe']
  }
  const relay = spawn(command.file, command.args, options)
  const control: RelayControl = { cancellationSent: false, failureMarkerSeen: false, diagnosticTail: '' }
  windowsJobRelays.set(relay, control)
  relay.stdin?.on('error', () => {})
  relay.stderr?.on('data', (chunk: Buffer) => {
    control.diagnosticTail = (control.diagnosticTail + chunk.toString('ascii')).slice(-512)
    if (control.diagnosticTail.includes('ARCKEEP_RELAY_FAILURE')) control.failureMarkerSeen = true
  })
  if (!relay.stdin) {
    try { relay.kill() } catch { /* no stream exists to deliver cancellation */ }
    throw new Error('无法创建 Windows 进程所有权 relay 的控制管道')
  }
  relay.stdin.write(`${encodeSpec(plan, cwd, parentPid)}\n`)
  return relay
}

export function isWindowsJobRelay(child: ChildProcess): boolean {
  return windowsJobRelays.has(child)
}

/** Request bounded, owner-confirmed cleanup through the relay control pipe. */
export function cancelWindowsJobRelay(child: ChildProcess): boolean {
  const control = windowsJobRelays.get(child)
  if (!control) return false
  if (control.cancellationSent) return true
  const input = child.stdin
  if (!input || input.destroyed || !input.writable || input.writableEnded) return false
  control.cancellationSent = true
  try {
    input.end('C\n')
    return true
  } catch {
    control.cancellationSent = false
    return false
  }
}

export function windowsJobRelayFailed(child: ChildProcess): boolean {
  return windowsJobRelays.get(child)?.failureMarkerSeen ?? false
}

function isReadyExecutable(file: string): boolean {
  try {
    const stat = statSync(file)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

function windowsPowerShell(env: NodeJS.ProcessEnv): string {
  const windows = env.WINDIR ?? env.SystemRoot
  if (!windows) return 'powershell.exe'
  const absolute = path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(absolute) ? absolute : 'powershell.exe'
}

function getRelayCache(): RelayCache {
  if (relayCache) return relayCache
  const directory = mkdtempSync(path.join(tmpdir(), 'arckeep-job-relay-'))
  const cache: RelayCache = {
    directory,
    source: path.join(directory, 'ArckeepProcessRelay.cs'),
    bootstrap: path.join(directory, 'bootstrap.ps1'),
    executable: path.join(directory, 'ArckeepProcessRelay.exe')
  }
  try {
    writeFileSync(cache.source, relaySource, 'utf8')
    writeFileSync(cache.bootstrap, bootstrapScript, 'utf8')
  } catch (error) {
    removeRelayDirectory(directory)
    throw error
  }
  relayCache = cache
  process.once('exit', () => removeRelayDirectory(directory))
  return cache
}

function removeRelayDirectory(directory: string): void {
  const tempRoot = path.resolve(tmpdir())
  const target = path.resolve(directory)
  if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith('arckeep-job-relay-')) return
  try { rmSync(target, { recursive: true, force: true }) } catch { /* temp cleanup is best effort */ }
}

function encodeSpec(plan: WindowsRelayPlan, cwd: string, parentPid: number): string {
  const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64')
  return [
    String(parentPid),
    encode(plan.file),
    encode(cwd),
    plan.windowsVerbatimArguments ? '1' : '0',
    String(plan.args.length),
    ...plan.args.map(encode)
  ].join('\t')
}

const bootstrapScript = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$relayPath = Join-Path $PSScriptRoot 'ArckeepProcessRelay.exe'
$sourcePath = Join-Path $PSScriptRoot 'ArckeepProcessRelay.cs'
$stagePath = Join-Path $PSScriptRoot ('relay-' + [guid]::NewGuid().ToString('N') + '.exe')
$publishPath = Join-Path $PSScriptRoot ('publish-' + [guid]::NewGuid().ToString('N') + '.exe')
try {
  if ([System.IO.File]::Exists($relayPath) -and (New-Object System.IO.FileInfo $relayPath).Length -eq 0) {
    [System.IO.File]::Delete($relayPath)
  }
  if (-not [System.IO.File]::Exists($relayPath)) {
    $compilerCandidates = @(
      (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
      (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
    )
    $compiler = $compilerCandidates | Where-Object { [System.IO.File]::Exists($_) } | Select-Object -First 1
    if (-not $compiler) { throw 'system compiler unavailable' }
    & $compiler '/nologo' '/target:exe' "/out:$stagePath" $sourcePath *> $null
    if ($LASTEXITCODE -ne 0 -or -not [System.IO.File]::Exists($stagePath)) { throw 'relay compilation failed' }
    [System.IO.File]::Copy($stagePath, $publishPath)
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
      try {
        [System.IO.File]::Move($publishPath, $relayPath)
        break
      } catch {
        if ([System.IO.File]::Exists($relayPath)) { break }
        if ($attempt -eq 4) { throw }
        Start-Sleep -Milliseconds 120
      }
    }
  }
  $specLine = [System.Console]::In.ReadLine()
  if ($null -eq $specLine) { exit 125 }
  if ($specLine -eq 'PREPARE') { exit 0 }
  $assembly = [System.Reflection.Assembly]::LoadFrom($relayPath)
  $relayType = $assembly.GetType('ArckeepProcessRelay', $true)
  $run = $relayType.GetMethod('Run', [System.Reflection.BindingFlags]::Public -bor [System.Reflection.BindingFlags]::Static)
  $exitCode = $run.Invoke($null, [object[]]@($specLine))
  exit [int]$exitCode
} catch {
  [System.Console]::Error.WriteLine('ARCKEEP_RELAY_FAILURE')
  exit 125
} finally {
  foreach ($staged in @($stagePath, $publishPath)) {
    try {
      if ([System.IO.File]::Exists($staged)) { [System.IO.File]::Delete($staged) }
    } catch { }
  }
}`

const relaySource = String.raw`using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ArckeepProcessRelay
{
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateNoWindow = 0x08000000;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectBasicAccountingInformation = 1;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint Infinite = 0xFFFFFFFF;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 258;
    private const uint WaitFailed = 0xFFFFFFFF;
    private const uint Synchronize = 0x00100000;
    private const uint StdInputHandle = 0xFFFFFFF6;
    private const uint StdOutputHandle = 0xFFFFFFF5;
    private const uint StdErrorHandle = 0xFFFFFFF4;
    private const uint HandleFlagInherit = 1;
    private const uint GenericRead = 0x80000000;
    private const uint OpenExisting = 3;
    private const uint FileShareRead = 1;
    private const uint FileShareWrite = 2;
    private const uint FileAttributeNormal = 0x00000080;
    private const int CleanupTimeoutMs = 15000;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public IntPtr MinimumWorkingSetSize;
        public IntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public IntPtr ProcessMemoryLimit;
        public IntPtr JobMemoryLimit;
        public IntPtr PeakProcessMemoryUsed;
        public IntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobAccountingInformation
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    private sealed class RelayFailure : Exception
    {
        public readonly int ExitCode;
        public RelayFailure(string message, int exitCode) : base(message) { ExitCode = exitCode; }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, uint infoClass, ref ExtendedLimitInformation info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, uint infoClass, out JobAccountingInformation info,
        uint length, IntPtr returnLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory,
        ref StartupInfo startupInfo, out ProcessInformation processInformation);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(uint handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "CreateFileW", SetLastError = true)]
    private static extern IntPtr CreateFile(string name, uint access, uint shareMode, IntPtr securityAttributes,
        uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    public static int Main(string[] args)
    {
        string spec;
        try { spec = Console.In.ReadLine(); }
        catch { return Fail("ARCKEEP_RELAY_FAILURE", 125); }
        if (spec == null) return Fail("ARCKEEP_RELAY_FAILURE", 125);
        return Run(spec);
    }

    public static int Run(string payload)
    {
        string[] fields;
        uint parentPid;
        string file;
        string cwd;
        bool verbatim;
        string[] args;
        try
        {
            fields = payload.Split(new char[] { '\t' }, StringSplitOptions.None);
            int count;
            if (fields.Length < 5 || !UInt32.TryParse(fields[0], out parentPid) ||
                !Int32.TryParse(fields[4], out count) || count < 0 || fields.Length != count + 5)
                throw new FormatException();
            file = Decode(fields[1]);
            cwd = Decode(fields[2]);
            verbatim = fields[3] == "1";
            args = new string[count];
            for (int i = 0; i < count; i++) args[i] = Decode(fields[i + 5]);
        }
        catch { return Fail("ARCKEEP_RELAY_FAILURE", 125); }

        IntPtr parent = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        IntPtr nullInput = IntPtr.Zero;
        ProcessInformation process = new ProcessInformation();
        ManualResetEvent cancelEvent = new ManualResetEvent(false);
        bool assignedToJob = false;
        bool jobWaitEntered = false;
        StartCancellationReader(cancelEvent);
        try
        {
            parent = OpenProcess(Synchronize, false, parentPid);
            if (parent == IntPtr.Zero) throw new RelayFailure("ARCKEEP_RELAY_FAILURE", 125);
            if (WaitForSingleObject(parent, 0) == WaitObject0) return 125;
            if (cancelEvent.WaitOne(0)) return 130;

            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new RelayFailure("ARCKEEP_RELAY_FAILURE", 125);
            ExtendedLimitInformation limits = new ExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
                (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation))))
                throw new RelayFailure("ARCKEEP_RELAY_FAILURE", 125);

            nullInput = CreateFile("NUL", GenericRead, FileShareRead | FileShareWrite, IntPtr.Zero,
                OpenExisting, FileAttributeNormal, IntPtr.Zero);
            if (nullInput == IntPtr.Zero || nullInput == new IntPtr(-1) ||
                !SetHandleInformation(nullInput, HandleFlagInherit, HandleFlagInherit))
                throw new RelayFailure("ARCKEEP_RELAY_FAILURE", 125);

            StartupInfo startup = new StartupInfo();
            startup.cb = Marshal.SizeOf(typeof(StartupInfo));
            startup.dwFlags = StartfUseStdHandles;
            startup.hStdInput = nullInput;
            startup.hStdOutput = InheritableStdHandle(StdOutputHandle);
            startup.hStdError = InheritableStdHandle(StdErrorHandle);
            IntPtr controlInput = GetStdHandle(StdInputHandle);
            if (controlInput != IntPtr.Zero && controlInput != new IntPtr(-1))
                SetHandleInformation(controlInput, HandleFlagInherit, 0);

            StringBuilder commandLine = new StringBuilder(BuildCommandLine(file, args, verbatim));
            if (!CreateProcess(null, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                CreateSuspended | CreateNoWindow, IntPtr.Zero, cwd, ref startup, out process))
            {
                int error = Marshal.GetLastWin32Error();
                if (error == 2 || error == 3)
                    throw new RelayFailure("ARCKEEP_RELAY_EXECUTABLE_NOT_FOUND", 127);
                throw new RelayFailure("ARCKEEP_RELAY_FAILURE", 125);
            }
            if (!AssignProcessToJobObject(job, process.hProcess))
                throw new RelayFailure("ARCKEEP_RELAY_FAILURE", 125);
            assignedToJob = true;
            if (WaitForSingleObject(parent, 0) == WaitObject0)
            {
                TerminateJobAndWait(job);
                return 125;
            }
            if (cancelEvent.WaitOne(0))
            {
                TerminateJobAndWait(job);
                return 130;
            }
            if (ResumeThread(process.hThread) == 0xFFFFFFFF)
                throw new RelayFailure("ARCKEEP_RELAY_FAILURE", 125);

            jobWaitEntered = true;
            int completion = WaitForJobProcesses(job, parent, cancelEvent);
            if (completion == 1) return 125;
            if (completion == 2) return 130;
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode))
                throw new RelayFailure("ARCKEEP_RELAY_FAILURE", 125);
            return unchecked((int)exitCode);
        }
        catch (RelayFailure failure)
        {
            if (!jobWaitEntered) CleanupFailedStart(job, process, assignedToJob);
            return Fail(failure.Message, failure.ExitCode);
        }
        catch
        {
            if (!jobWaitEntered) CleanupFailedStart(job, process, assignedToJob);
            return Fail("ARCKEEP_RELAY_FAILURE", 125);
        }
        finally
        {
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (nullInput != IntPtr.Zero && nullInput != new IntPtr(-1)) CloseHandle(nullInput);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (parent != IntPtr.Zero) CloseHandle(parent);
            cancelEvent.Dispose();
        }
    }

    private static string Decode(string value)
    {
        return Encoding.UTF8.GetString(Convert.FromBase64String(value));
    }

    private static int Fail(string marker, int exitCode)
    {
        Console.Error.WriteLine(marker);
        return exitCode;
    }

    private static void CleanupFailedStart(IntPtr job, ProcessInformation process, bool assignedToJob)
    {
        if (assignedToJob && job != IntPtr.Zero)
        {
            try { TerminateJobAndWait(job); } catch { /* report the original fixed relay failure */ }
        }
        else if (process.hProcess != IntPtr.Zero)
        {
            try
            {
                TerminateProcess(process.hProcess, 125);
                WaitForSingleObject(process.hProcess, CleanupTimeoutMs);
            }
            catch { /* report the original fixed relay failure */ }
        }
    }

    private static void StartCancellationReader(ManualResetEvent cancelEvent)
    {
        Thread cancelReader = new Thread(delegate()
        {
            try
            {
                string command = Console.In.ReadLine();
                if (command == null || command == "C") SignalCancellation(cancelEvent);
            }
            catch { SignalCancellation(cancelEvent); }
        });
        cancelReader.IsBackground = true;
        cancelReader.Start();
    }

    private static int WaitForJobProcesses(IntPtr job, IntPtr parent, ManualResetEvent cancelEvent)
    {
        IntPtr[] handles = new IntPtr[] { job, parent, cancelEvent.SafeWaitHandle.DangerousGetHandle() };
        for (;;)
        {
            if (GetActiveProcesses(job) == 0) return 0;
            uint result = WaitForMultipleObjects((uint)handles.Length, handles, false, 50);
            if (result == WaitObject0)
            {
                WaitForJobEmpty(job, CleanupTimeoutMs);
                return 0;
            }
            if (result == WaitObject0 + 1)
            {
                TerminateJobAndWait(job);
                return 1;
            }
            if (result == WaitObject0 + 2)
            {
                TerminateJobAndWait(job);
                return 2;
            }
            if (result != WaitTimeout) throw new RelayFailure("ARCKEEP_RELAY_FAILURE", 125);
        }
    }

    private static void SignalCancellation(ManualResetEvent cancelEvent)
    {
        try { cancelEvent.Set(); } catch (ObjectDisposedException) { }
    }

    private static uint GetActiveProcesses(IntPtr job)
    {
        JobAccountingInformation accounting;
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out accounting,
            (uint)Marshal.SizeOf(typeof(JobAccountingInformation)), IntPtr.Zero))
            throw new RelayFailure("ARCKEEP_RELAY_FAILURE", 125);
        return accounting.ActiveProcesses;
    }

    private static void TerminateJobAndWait(IntPtr job)
    {
        if (GetActiveProcesses(job) == 0) return;
        if (!TerminateJobObject(job, 125) && GetActiveProcesses(job) != 0)
            throw new RelayFailure("ARCKEEP_RELAY_FAILURE", 125);
        WaitForJobEmpty(job, CleanupTimeoutMs);
    }

    private static void WaitForJobEmpty(IntPtr job, int timeoutMs)
    {
        Stopwatch timer = Stopwatch.StartNew();
        for (;;)
        {
            if (GetActiveProcesses(job) == 0) return;
            long remaining = timeoutMs - timer.ElapsedMilliseconds;
            if (remaining <= 0) throw new RelayFailure("ARCKEEP_RELAY_FAILURE", 125);
            uint result = WaitForSingleObject(job, (uint)Math.Min(25, remaining));
            if (result == WaitFailed) throw new RelayFailure("ARCKEEP_RELAY_FAILURE", 125);
            if (result != WaitTimeout && result != WaitObject0)
                throw new RelayFailure("ARCKEEP_RELAY_FAILURE", 125);
        }
    }

    private static IntPtr InheritableStdHandle(uint id)
    {
        IntPtr handle = GetStdHandle(id);
        if (handle == IntPtr.Zero || handle == new IntPtr(-1) ||
            !SetHandleInformation(handle, HandleFlagInherit, HandleFlagInherit))
            throw new RelayFailure("ARCKEEP_RELAY_FAILURE", 125);
        return handle;
    }

    private static string BuildCommandLine(string file, string[] args, bool verbatim)
    {
        StringBuilder result = new StringBuilder(QuoteArgument(file));
        foreach (string arg in args)
        {
            result.Append(' ');
            result.Append(verbatim ? arg : QuoteArgument(arg));
        }
        return result.ToString();
    }

    private static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.IndexOf('"') < 0 && !ContainsWhitespace(value)) return value;
        StringBuilder result = new StringBuilder();
        result.Append('"');
        int slashes = 0;
        foreach (char current in value)
        {
            if (current == '\\') { slashes++; continue; }
            if (current == '"')
            {
                result.Append('\\', slashes * 2 + 1);
                result.Append('"');
                slashes = 0;
                continue;
            }
            result.Append('\\', slashes);
            result.Append(current);
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static bool ContainsWhitespace(string value)
    {
        foreach (char current in value) if (Char.IsWhiteSpace(current)) return true;
        return false;
    }
}`
