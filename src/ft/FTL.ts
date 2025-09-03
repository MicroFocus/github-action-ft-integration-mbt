import { spawn } from 'child_process';
import { ExitCode } from '../ft/ExitCode';
import * as fsp from 'fs/promises';
import path from "path";
import { Logger } from "../utils/logger";
import { config } from '../config/config';

const HP_TL_EXE = 'HpToolsLauncher.exe';
const logger = new Logger("FTL");

export default class FTL {
  public static readonly FileSystem = "FileSystem";
  public static readonly MBT = "MBT";
  public static readonly _MBT = "___mbt";
  public static async ensureToolExists(): Promise<string> {
    logger.debug(`ensureToolExists: Checking for ${HP_TL_EXE} ...`);
    const runnerWorkspace = config.runnerWorkspacePath;
    const actionRepo = process.env.GITHUB_ACTION_REPOSITORY;
    const actionRef = process.env.GITHUB_ACTION_REF;

    let missing = "";
    if (!runnerWorkspace) {
      missing = `RUNNER_WORKSPACE`;
    } else if (!actionRepo) {
      missing = `GITHUB_ACTION_REPOSITORY`;
    } else if (!actionRef) {
      missing = `GITHUB_ACTION_REF`;
    }
    if (missing) {
      const err = `Missing required environment variable: ${missing}`;
      logger.error(`ensureToolExists: ${err}`);
      throw new Error(err);
    }

    // Extract base runner path (remove the repo name from the end)
    const runnerRoot = path.resolve(runnerWorkspace, '..'); // Go up one level
    const [owner, repo] = actionRepo!.split('/');
    const actionBinPath = path.join(runnerRoot, '_actions', owner, repo, actionRef!, 'bin');
    const exeFullPath = path.join(actionBinPath, HP_TL_EXE);
    try {
      await fsp.access(exeFullPath, fsp.constants.F_OK);
      logger.debug(`Located [${exeFullPath}]`);
      return actionBinPath; // Return the bin path where HpToolsLauncher.exe is located
    } catch (error: any) {
      const err = `Failed to locate [${exeFullPath}]: ${error.message}`;
      logger.error(err);
      throw new Error(err);
    }
  }
  public static async runTool(binPath: string, propsFullPath: string): Promise<ExitCode> {
    logger.debug(`runTool: binPath=[${binPath}], propsFullPath=[${propsFullPath}] ...`);
    const args = ['-paramfile', propsFullPath];
    try {
      await fsp.access(path.join(binPath, HP_TL_EXE), fsp.constants.F_OK | fsp.constants.X_OK);
      logger.info(`${HP_TL_EXE} ${args.join(' ')}`);

      return await new Promise<ExitCode>((resolve, reject) => {
        const launcher = spawn(HP_TL_EXE, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: binPath, // Set working directory to action's bin folder
        });
        launcher.stdout.on('data', (data) => {
          const msg = data?.toString().trim();
          msg && logger.info(msg);
        });

        launcher.stderr.on('data', (data) => {
          const err = data?.toString().trim();
          err && logger.error(err);
        });

        launcher.on('error', (error) => {
          reject(new Error(`Failed to start HpToolsLauncher: ${error.message}`));
        });

        launcher.on('close', (code) => {
          // Node.js returns unsigned 32-bit for negative codes (e.g., -2 => 4294967294)
          // Normalize to signed 32-bit integer
          let normalizedCode: number;
          if (typeof code === 'number') {
            normalizedCode = code > 0x7FFFFFFF ? code - 0x100000000 : code;
          } else {
            logger.error('runTool: Process exited with null code (possibly killed by signal)');
            resolve(ExitCode.Aborted); // or another appropriate value
            return;
          }

          logger.debug(`runTool: ExitCode=${normalizedCode}`);
          const exitCode = Object.values(ExitCode).includes(normalizedCode)
            ? (normalizedCode as ExitCode)
            : ExitCode.Unkonwn;
          resolve(exitCode);
        });
      });
    } catch (error: any) {
      logger.error(`runTool: ${error.message}`);
      throw new Error(`Failed to run HpToolsLauncher: ${error.message}`);
    }
  }
}