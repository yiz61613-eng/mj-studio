using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

// 漫剧直出工作台 一键安装器
// 功能：释放文件 → 注册登录启动任务（本地直通服务）→ 写入 Edge/Chrome 扩展策略（自动装 RB 扩展）→ 创建桌面快捷方式
class Installer
{
    const string AppDirName = "MjStudio";
    const string TaskName = "MjStudioServer";
    const string ExtId = "dgcljenlemochdpacfklflgnaphaaiil";
    const string UpdateUrl = "http://localhost:8899/updates.xml";

    static string baseDir;
    static bool serverOk;

    [STAThread]
    static void Main()
    {
        baseDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), AppDirName);
        var log = new System.Text.StringBuilder();
        try
        {
            ExtractAll(log);
            StartServer(log);
            RegisterTask(log);
            InstallExtension(log);
            CreateShortcut(log);
            WriteUninstaller(log);
            LaunchWorkbench(log);
            MessageBox.Show((serverOk ? "安装完成！" : "安装基本完成，但本地服务没起来：") + "\n\n" + log + "\n\n· 桌面快捷方式「漫剧直出工作台」已创建\n· RB 扩展将在重启 Edge/Chrome 后自动出现\n· 生成按钮永远由你自己点", "漫剧直出工作台", MessageBoxButtons.OK, serverOk ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
        }
        catch (Exception ex)
        {
            MessageBox.Show("安装出错：\n" + ex.Message + "\n\n已完成的部分：\n" + log, "漫剧直出工作台", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    static void CopyRes(string resName, string targetPath)
    {
        var asm = Assembly.GetExecutingAssembly();
        using (var s = asm.GetManifestResourceStream(resName))
        {
            if (s == null) throw new Exception("缺少内置资源：" + resName);
            Directory.CreateDirectory(Path.GetDirectoryName(targetPath));
            using (var f = File.Create(targetPath)) s.CopyTo(f);
        }
    }

    static void ExtractAll(StringBuilder log)
    {
        if (Directory.Exists(baseDir)) { try { Directory.Delete(baseDir, true); } catch (Exception e) { log.AppendLine("旧目录清理跳过：" + e.Message); } }
        Directory.CreateDirectory(baseDir);
        CopyRes("MjStudio.node.exe", Path.Combine(baseDir, "node", "node.exe"));
        CopyRes("MjStudio.server.dat", Path.Combine(baseDir, "server", "server.dat"));
        CopyRes("MjStudio.boot.js", Path.Combine(baseDir, "server", "boot.js"));
        CopyRes("MjStudio.workbench.index.enc", Path.Combine(baseDir, "workbench", "index.enc"));
        CopyRes("MjStudio.workbench.mapping.enc", Path.Combine(baseDir, "workbench", "mapping.enc"));
        foreach (var f in new[] { "extension.crx", "updates.xml", "manifest.json", "background.js", "rb-core.js", "rb-adapter-runroll.js", "rb-adapter-updream.js", "rb-content-bridge.js" })
            CopyRes("MjStudio.ext." + f, Path.Combine(baseDir, "server", "extension", f));

        // 静默启动脚本（登录时后台运行，无窗口）
        var vbs = "CreateObject(\"WScript.Shell\").Run \"\"\"\" & \"" +
                  Path.Combine(baseDir, "node", "node.exe") + "\"\" \"\"\" & \"" +
                  Path.Combine(baseDir, "server", "boot.js") + "\"\"\"\", 0, False";
        File.WriteAllText(Path.Combine(baseDir, "run-server.vbs"), vbs);
        log.AppendLine("✔ 文件已释放到 " + baseDir);
    }

    static void StartServer(StringBuilder log)
    {
        Run("schtasks", "/Run /TN \"" + TaskName + "\"", false); // 若任务已存在先跑一次
        var psi = new ProcessStartInfo("wscript.exe", "\"" + Path.Combine(baseDir, "run-server.vbs") + "\"");
        psi.UseShellExecute = true;
        Process.Start(psi);
        serverOk = HealthCheck(log);
    }

    // [FIX-20260923] 不再赌 1.5 秒：轮询 /__health 最多 10 秒，失败时给出可读诊断
    static bool HealthCheck(StringBuilder log)
    {
        for (int i = 0; i < 40; i++)
        {
            try
            {
                var req = (System.Net.HttpWebRequest)System.Net.WebRequest.Create("http://localhost:8899/__health");
                req.Timeout = 1000; req.Proxy = null;
                using (var resp = (System.Net.HttpWebResponse)req.GetResponse())
                {
                    if ((int)resp.StatusCode == 200)
                    {
                        log.AppendLine("✔ 本地直通服务已就绪（localhost:8899，等待 " + ((i + 1) / 4.0).ToString("0.#") + " 秒）");
                        return true;
                    }
                }
            }
            catch { }
            System.Threading.Thread.Sleep(250);
        }
        Diagnose(log);
        return false;
    }

    static void Diagnose(StringBuilder log)
    {
        log.AppendLine("✘ 服务 10 秒内未就绪（localhost:8899 连不上）");
        bool portTaken = false;
        try
        {
            var l = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 8899);
            l.Start(); l.Stop();
        }
        catch { portTaken = true; }
        bool nodeRunning = false;
        try { nodeRunning = Process.GetProcessesByName("node").Length > 0; } catch { }
        if (portTaken) log.AppendLine("  → 8899 端口已被其他程序占用：关掉占用程序（netstat -ano | findstr 8899 查 PID）后重装");
        else if (!nodeRunning) log.AppendLine("  → 服务进程 node.exe 没在跑：多半被杀毒软件拦截/隔离，请把 " + baseDir + " 加入白名单后重新运行安装程序");
        else log.AppendLine("  → 进程在但端口不通：重启电脑再试一次；仍不行请截图本弹窗反馈");
    }

    static void RegisterTask(StringBuilder log)
    {
        var tr = "wscript.exe \"" + Path.Combine(baseDir, "run-server.vbs") + "\"";
        Run("schtasks", "/Create /F /SC ONLOGON /TN \"" + TaskName + "\" /TR \"" + tr + "\"", true);
        log.AppendLine("✔ 已注册开机自动启动任务（" + TaskName + "）");
    }

    static void InstallExtension(StringBuilder log)
    {
        var value = ExtId + ";" + UpdateUrl;
        bool any = false;
        string[] policies = {
            @"SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist",
            @"SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist"
        };
        foreach (var p in policies)
        {
            try
            {
                using (var k = Registry.LocalMachine.CreateSubKey(p))
                {
                    k.SetValue("1", value);
                    any = true;
                    log.AppendLine("✔ 已为 " + (p.Contains("Edge") ? "Edge" : "Chrome") + " 注册 RB 扩展（重启浏览器生效）");
                }
            }
            catch (Exception e) { log.AppendLine("✘ " + (p.Contains("Edge") ? "Edge" : "Chrome") + " 扩展注册失败：" + e.Message); }
        }
        if (!any) log.AppendLine("提示：请手动在扩展页开启「开发者模式」加载 " + Path.Combine(baseDir, "server", "extension"));
    }

    static void CreateShortcut(StringBuilder log)
    {
        try
        {
            var desk = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            var lnk = Path.Combine(desk, "漫剧直出工作台.lnk");
            var t = Type.GetTypeFromProgID("WScript.Shell");
            dynamic sh = Activator.CreateInstance(t);
            var sc = sh.CreateShortcut(lnk);
            sc.TargetPath = "http://localhost:8899/";
            sc.Description = "漫剧直出工作台";
            sc.Save();
            log.AppendLine("✔ 桌面快捷方式已创建");
        }
        catch (Exception e) { log.AppendLine("✘ 快捷方式创建失败：" + e.Message); }
    }

    static void WriteUninstaller(StringBuilder log)
    {
        var un = "@echo off\r\n" +
                 "schtasks /Delete /F /TN \"" + TaskName + "\"\r\n" +
                 "reg delete \"HKLM\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallForcelist\" /v 1 /f\r\n" +
                 "reg delete \"HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist\" /v 1 /f\r\n" +
                 "echo 卸载完成（可手动删除本目录与桌面快捷方式）\r\npause\r\n";
        File.WriteAllText(Path.Combine(baseDir, "uninstall.cmd"), un);
    }

    static void LaunchWorkbench(StringBuilder log)
    {
        if (!serverOk) { log.AppendLine("✘ 跳过打开工作台（服务未就绪，见上方诊断）"); return; }
        try
        {
            var psi = new ProcessStartInfo("http://localhost:8899/");
            psi.UseShellExecute = true;
            Process.Start(psi);
        }
        catch (Exception e) { log.AppendLine("✘ 打开工作台失败：" + e.Message); }
    }

    static void Run(string exe, string args, bool throwOnError)
    {
        var psi = new ProcessStartInfo(exe, args);
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        var p = Process.Start(psi);
        p.WaitForExit(15000);
        if (throwOnError && p.ExitCode != 0)
            throw new Exception(exe + " " + args + " 失败（exit " + p.ExitCode + "）");
    }
}
