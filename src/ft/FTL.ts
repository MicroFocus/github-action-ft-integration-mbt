import { spawn } from 'child_process';
import { ExitCode } from '../ft/ExitCode';
import * as fsp from 'fs/promises';
import path from "path";
import { Logger } from "../utils/logger";
const _logger = new Logger("FTL");
const HP_TL_EXE = 'HpToolsLauncher.exe';
export default class FTL {
  public static async ensureToolExists(): Promise<string> {
    _logger.debug(`ensureToolExists: Checking for ${HP_TL_EXE} ...`);
    const runnerWorkspace = process.env.RUNNER_WORKSPACE;
    const actionRepo = process.env.GITHUB_ACTION_REPOSITORY;
    const actionRef = process.env.GITHUB_ACTION_REF;

    let err = "";
    if (!runnerWorkspace) {
      err = `Missing required environment variable: RUNNER_WORKSPACE.`;
    } else if (!actionRepo) {
      err = `Missing required environment variable: GITHUB_ACTION_REPOSITORY.`;
    } else if (!actionRef) {
      err = `Missing required environment variable: GITHUB_ACTION_REF.`;
    }
    if (err) {
      _logger.error(err);
      throw new Error(err);
    }

    // Extract base runner path (remove the repo name from the end)
    const runnerRoot = path.resolve(runnerWorkspace!, '..'); // Go up one level
    const [owner, repo] = actionRepo!.split('/');
    const actionBinPath = path.join(runnerRoot, '_actions', owner, repo, actionRef!, 'bin');
    const exeFullPath = path.join(actionBinPath, HP_TL_EXE);
    try {
      await fsp.access(exeFullPath, fsp.constants.F_OK);
      _logger.debug(`Located [${exeFullPath}]`);
      return actionBinPath; // Return the bin path where HpToolsLauncher.exe is located
    } catch (error: any) {
      const err = `Failed to locate [${exeFullPath}]: ${error.message}`;
      _logger.error(err);
      throw new Error(err);
    }
  }
  public static async runTool(binPath: string, propsFullPath: string): Promise<ExitCode> {
    _logger.debug(`runTool: binPath=[${binPath}], propsFullPath=[${propsFullPath}] ...`);
    const args = ['-paramfile', propsFullPath];
    try {
      await fsp.access(path.join(binPath, HP_TL_EXE), fsp.constants.F_OK | fsp.constants.X_OK);
      _logger.info(`${HP_TL_EXE} ${args.join(' ')}`);

      return await new Promise<ExitCode>((resolve, reject) => {
        const launcher = spawn(HP_TL_EXE, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: binPath, // Set working directory to action's bin folder
        });
        launcher.stdout.on('data', (data) => {
          const msg = data?.toString().trim();
          msg && _logger.info(msg);
        });

        launcher.stderr.on('data', (data) => {
          const err = data?.toString().trim();
          err && _logger.error(err);
        });

        launcher.on('error', (error) => {
          reject(new Error(`Failed to start HpToolsLauncher: ${error.message}`));
        });

        launcher.on('close', (code) => {
          _logger.debug(`runTool: ExitCode=${code}`);
          // Map exit code to ExitCode enum, default to Aborted for unknown codes
          const exitCode = Object.values(ExitCode)
            .filter((v): v is number => typeof v === 'number')
            .includes(code ?? -3)
            ? (code as ExitCode)
            : ExitCode.Unkonwn;
          resolve(exitCode);
        });
      });
    } catch (error: any) {
      _logger.error(`runTool: ${error.message}`);
      throw new Error(`Failed to run HpToolsLauncher: ${error.message}`);
    }
  }
}