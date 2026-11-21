$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$payload = [Console]::ReadLine() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
public static class AtkJob {
  public static bool SafeFailure = true;
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC {
    public long a,b; public uint flags; public UIntPtr min,max; public uint active;
    public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct LIMIT {
    public BASIC basic; public IO io; public UIntPtr a,b,c,d;
  }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNT {
    public long a,b,c,d; public uint faults,total,active,terminated;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct START {
    public uint size; public string reserved,desktop,title; public uint x,y,w,h,cx,cy,fill,flags;
    public ushort show, cb; public IntPtr data,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,ref LIMIT l,uint n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr j,int c,ref ACCOUNT a,uint n,IntPtr r);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string a,StringBuilder c,IntPtr p,IntPtr t,bool inherit,uint flags,IntPtr env,string cwd,ref START s,out PROCESS info);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr p,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr p,uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr j,uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static string Quote(string value) {
    var result=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) {
      if(c=='\\') { slashes++; continue; }
      if(c=='"') result.Append('\\',slashes*2+1); else result.Append('\\',slashes);
      result.Append(c); slashes=0;
    }
    result.Append('\\',slashes*2); return result.Append('"').ToString();
  }
  public static int Run(string executable,string[] args,string cwd) {
    IntPtr job=CreateJobObject(IntPtr.Zero,null); PROCESS p=new PROCESS();
    if(job==IntPtr.Zero) throw new Exception("Cannot create CI job");
    try {
      var limit=new LIMIT(); limit.basic.flags=0x2000;
      if(!SetInformationJobObject(job,9,ref limit,(uint)Marshal.SizeOf(limit))) throw new Exception("Cannot set CI job limits");
      var command=new StringBuilder(Quote(executable)); foreach(string arg in args ?? new string[0]) command.Append(" ").Append(Quote(arg));
      var start=new START(); start.size=(uint)Marshal.SizeOf(start); start.flags=0x100;
      start.input=IntPtr.Zero; start.output=GetStdHandle(-11); start.error=GetStdHandle(-12);
      if(!CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x4|0x08000000,IntPtr.Zero,cwd,ref start,out p))
        throw new Exception("Cannot start CI executable: "+Marshal.GetLastWin32Error());
      SafeFailure=false;
      if(!AssignProcessToJobObject(job,p.process)) { TerminateProcess(p.process,125); SafeFailure=WaitForSingleObject(p.process,5000)==0; throw new Exception("Cannot assign CI process to job"); }
      var watcher=new Thread(()=> { try { while(Console.ReadLine()!=null) {} } catch {} TerminateJobObject(job,1); });
      watcher.IsBackground=true; watcher.Start();
      ResumeThread(p.thread); WaitForSingleObject(p.process,0xffffffff);
      uint code; GetExitCodeProcess(p.process,out code);
      TerminateJobObject(job,1);
      for(int i=0;i<500;i++) {
        var account=new ACCOUNT();
        if(!QueryInformationJobObject(job,1,ref account,(uint)Marshal.SizeOf(account),IntPtr.Zero)) throw new Exception("Cannot confirm CI job termination");
        if(account.active==0) return (int)code;
        Thread.Sleep(10);
      }
      throw new Exception("CI job did not confirm termination");
    } finally {
      if(p.thread!=IntPtr.Zero) CloseHandle(p.thread);
      if(p.process!=IntPtr.Zero) CloseHandle(p.process);
      CloseHandle(job);
    }
  }
}
'@
try {
  $exitCode = [AtkJob]::Run($payload.executable, [string[]]$payload.args, $payload.cwd)
  [Console]::Error.WriteLine("`n::atk-supervisor::" + $payload.nonce + "::" + $exitCode)
  exit 0
}
catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  if ([AtkJob]::SafeFailure) {
    [Console]::Error.WriteLine("`n::atk-supervisor::" + $payload.nonce + "::127")
    exit 0
  }
  exit 125
}
