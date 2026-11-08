using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
using System.Reflection;

[assembly: AssemblyTitle("Claudex")]
[assembly: AssemblyProduct("Claudex")]
[assembly: AssemblyFileVersion("0.3.1.0")]
[assembly: AssemblyVersion("0.3.1.0")]

internal static class Claudex
{
    [STAThread]
    private static int Main()
    {
        string directory = AppDomain.CurrentDomain.BaseDirectory;
        string script = Path.Combine(directory, "launch", "start.ps1");
        try
        {
            if (!File.Exists(script))
                throw new FileNotFoundException("请先完整解压 Claudex，再从解压目录启动。", script);
            string shell = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
            var start = new ProcessStartInfo(shell, "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"");
            start.WorkingDirectory = directory;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            using (Process bootstrap = Process.Start(start))
            {
                bootstrap.WaitForExit();
                return bootstrap.ExitCode;
            }
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Claudex 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
