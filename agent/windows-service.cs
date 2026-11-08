using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Text;
using System.Threading;

internal sealed class StatoFactService : ServiceBase
{
    private const string ServiceId = "StatoFactAgent";
    private readonly ManualResetEvent stopping = new ManualResetEvent(false);
    private Thread worker;

    internal StatoFactService()
    {
        ServiceName = ServiceId;
        CanStop = true;
        AutoLog = false;
    }

    private static string DefaultConfigPath
    {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "StatoFact", "agent.conf"); }
    }

    private static string DefaultAgentPath
    {
        get { return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "statofact-agent-windows.exe"); }
    }

    private static string LogPath
    {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "StatoFact", "service.log"); }
    }

    private static void Log(string message)
    {
        string line = DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine;
        try
        {
            if (File.Exists(LogPath) && new FileInfo(LogPath).Length > 1024 * 1024)
                File.WriteAllText(LogPath, line, Encoding.UTF8);
            else
                File.AppendAllText(LogPath, line, Encoding.UTF8);
        }
        catch (IOException error)
        {
            EventLog.WriteEntry("Application", "StatoFact: Protokollierung fehlgeschlagen: " + error.Message, EventLogEntryType.Error);
        }
        catch (UnauthorizedAccessException error)
        {
            EventLog.WriteEntry("Application", "StatoFact: Protokollierung fehlgeschlagen: " + error.Message, EventLogEntryType.Error);
        }
    }

    internal static int ReadIntervalMinutes(string configPath)
    {
        int interval = 0;
        bool found = false;
        foreach (string line in File.ReadAllLines(configPath, Encoding.UTF8))
        {
            if (!line.StartsWith("STATOFACT_INTERVAL_MINUTES=", StringComparison.Ordinal))
                continue;
            if (found || !Int32.TryParse(line.Substring("STATOFACT_INTERVAL_MINUTES=".Length).Trim(), out interval)
                || interval < 1 || interval > 1440)
                throw new InvalidDataException("STATOFACT_INTERVAL_MINUTES muss einmalig zwischen 1 und 1440 liegen.");
            found = true;
        }
        if (!found)
            throw new InvalidDataException("STATOFACT_INTERVAL_MINUTES fehlt in der Konfiguration.");
        return interval;
    }

    internal static int RunAgent(string agentPath, string configPath, WaitHandle stop, Action<string> log)
    {
        ProcessStartInfo start = new ProcessStartInfo(agentPath, "--config \"" + configPath + "\"");
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        start.WorkingDirectory = Path.GetDirectoryName(agentPath);
        start.EnvironmentVariables.Remove("STATOFACT_URL");
        start.EnvironmentVariables.Remove("STATOFACT_TOKEN");
        start.EnvironmentVariables.Remove("STATOFACT_NAME");
        start.EnvironmentVariables.Remove("STATOFACT_VIRTUALBOX_REGISTRY");
        start.EnvironmentVariables.Remove("STATOFACT_VMWARE_DIRECTORY");
        using (Process process = new Process())
        {
            process.StartInfo = start;
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) {
                if (!String.IsNullOrEmpty(e.Data)) log(e.Data);
            };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) {
                if (!String.IsNullOrEmpty(e.Data)) log("FEHLER: " + e.Data);
            };
            if (!process.Start())
                throw new InvalidOperationException("Agent konnte nicht gestartet werden.");
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            Stopwatch timeout = Stopwatch.StartNew();
            while (!process.WaitForExit(1000))
            {
                if (stop.WaitOne(0) || timeout.Elapsed > TimeSpan.FromMinutes(5))
                {
                    if (!process.HasExited)
                    {
                        process.Kill();
                        process.WaitForExit();
                    }
                    log(stop.WaitOne(0) ? "Agent beim Beenden angehalten." : "Agent nach Zeitüberschreitung beendet.");
                    return 1;
                }
            }
            process.WaitForExit();
            if (process.ExitCode != 0)
                log("Agent beendet mit Exit-Code " + process.ExitCode + ".");
            return process.ExitCode;
        }
    }

    protected override void OnStart(string[] args)
    {
        try
        {
            int interval = ReadIntervalMinutes(DefaultConfigPath);
            if (!File.Exists(DefaultAgentPath))
                throw new FileNotFoundException("Windows-Agent nicht gefunden.", DefaultAgentPath);
            worker = new Thread(delegate() { RunLoop(interval); });
            worker.IsBackground = true;
            worker.Start();
        }
        catch (Exception error)
        {
            Log("FEHLER beim Dienststart: " + error.Message);
            throw;
        }
    }

    private void RunLoop(int interval)
    {
        Log("Dienst gestartet; Intervall: " + interval + " Minuten.");
        while (!stopping.WaitOne(0))
        {
            try
            {
                RunAgent(DefaultAgentPath, DefaultConfigPath, stopping, Log);
            }
            catch (Exception error)
            {
                Log("FEHLER beim Agentenaufruf: " + error.Message);
            }
            if (stopping.WaitOne(TimeSpan.FromMinutes(interval)))
                break;
        }
        Log("Dienst beendet.");
    }

    protected override void OnStop()
    {
        stopping.Set();
        if (worker != null && !worker.Join(TimeSpan.FromSeconds(15)))
            throw new System.TimeoutException("Der Agent konnte nicht rechtzeitig beendet werden.");
    }

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "--stop")
            {
                using (ServiceController service = new ServiceController(ServiceId))
                {
                    if (service.Status != ServiceControllerStatus.Stopped)
                    {
                        if (service.Status != ServiceControllerStatus.StopPending)
                            service.Stop();
                        service.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(60));
                    }
                }
                return 0;
            }
            if (args.Length == 3 && args[0] == "--once")
            {
                ReadIntervalMinutes(args[2]);
                return RunAgent(Path.GetFullPath(args[1]), Path.GetFullPath(args[2]),
                    new ManualResetEvent(false), Console.WriteLine);
            }
            if (args.Length != 0)
                throw new ArgumentException("Ungültige Dienstargumente.");
            ServiceBase.Run(new StatoFactService());
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}
