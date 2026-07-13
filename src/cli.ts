import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { parse } from './parser.js';
import { compile } from './compiler.js';
import { validate } from './validate.js';
import { WorkflowRunner, MockAgentExecutor } from './runtime.js';
import type { ExecutorResolver } from './runtime.js';
import { ClaudeExecutor } from './executors/claude-executor.js';
import { OllamaExecutor } from './executors/ollama-executor.js';
import { resolveModel } from './model-resolver.js';
import { createBuiltinRegistry } from './tools/index.js';
import { runInit } from './commands/init.js';
import { OpenRouterExecutor } from './executors/openrouter-executor.js';
import { DeepSeekExecutor } from './executors/deepseek-executor.js';
import { HermesExecutor } from './executors/hermes-executor.js';
import { AgentSdkExecutor } from './executors/agent-sdk-executor.js';
import { buildRunReport, usageTotals, formatCostLine } from './cli-report.js';
import type { WorkflowIR, AgentDef, WorkflowInstance } from './types.js';

function loadAndCompile(filePath: string): WorkflowIR {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const source = readFileSync(filePath, 'utf-8');
  const ast = parse(source);
  return compile(ast);
}

/** Create an ExecutorResolver that resolves the model for each agent */
function createExecutorResolver(
  toolRegistry: ReturnType<typeof createBuiltinRegistry>,
): ExecutorResolver {
  return (agent: AgentDef) => {
    const modelConfig = resolveModel(agent.model);
    process.stderr.write(
      chalk.dim(`  📦 [${agent.id}] model: ${modelConfig.model} (${modelConfig.provider})\n`),
    );

    switch (modelConfig.provider) {
      case 'claude':
        return new ClaudeExecutor({ toolRegistry });
      case 'openrouter':
        return new OpenRouterExecutor(modelConfig.model);
      case 'deepseek':
        return new DeepSeekExecutor(modelConfig.model);
      case 'hermes':
        return new HermesExecutor();
      case 'agent-sdk':
        return new AgentSdkExecutor(modelConfig.model);
      case 'ollama':
      default:
        return new OllamaExecutor(modelConfig);
    }
  };
}

/**
 * Print phase results, loop info, cost, and a terminal summary, then exit with
 * an honest code: 0 completed, 1 failed, 2 paused (gate/HITL).
 */
function printResultsAndExit(
  instance: WorkflowInstance,
  ctx: { file: string; command: 'run' | 'resume'; outputDir: string; stateDir?: string },
): never {
  // Phase results
  console.log(chalk.bold('\n📊 Phase Results:'));
  for (const [phaseId, state] of Object.entries(instance.phase_states)) {
    const icon = state === 'completed' ? '✅' : state === 'failed' ? '❌' : '⏳';
    console.log(`   ${icon} ${phaseId}: ${state}`);
  }

  // Loop info
  for (const [loopId, iterations] of Object.entries(instance.loop_iterations)) {
    console.log(chalk.cyan(`\n🔄 Loop "${loopId}": ${iterations} iteration(s)`));
  }

  // Cost (stable, parseable line)
  console.log(chalk.bold(`\n💰 ${formatCostLine(usageTotals(instance))}`));

  // Instance / persistence info
  const stateName = `${instance.instance_id}.state.json`;
  const statePath = ctx.stateDir ? `${ctx.stateDir}/${stateName}` : stateName;
  console.log(chalk.bold(`\n📦 Workflow state: ${instance.state}`));
  console.log(chalk.dim(`   Instance: ${instance.instance_id}`));
  console.log(chalk.dim(`   State saved to: ${statePath}`));
  console.log(chalk.dim(`   Outputs saved to: ${ctx.outputDir}/`));

  // Terminal summary + honest exit code
  const report = buildRunReport(instance, { file: ctx.file, command: ctx.command });
  const color =
    report.exitCode === 0 ? chalk.green : report.exitCode === 2 ? chalk.yellow : chalk.red;
  console.log();
  for (const line of report.lines) console.log(color(line));
  process.exit(report.exitCode);
}

const program = new Command();

program
  .name('agentflow')
  .version('0.1.0')
  .description('AgentFlow DSL — declarative language for multi-agent orchestration');

// init command
program
  .command('init')
  .description('Interactive configuration wizard')
  .action(async () => {
    try {
      await runInit();
    } catch (err) {
      if ((err as Error).name === 'ExitPromptError') {
        console.log(chalk.yellow('\nSetup cancelled.'));
        process.exit(0);
      }
      throw err;
    }
  });

// compile command
program
  .command('compile <file>')
  .description('Compile .aflow file and output IR JSON to stdout')
  .action((file: string) => {
    try {
      const ir = loadAndCompile(file);
      console.log(JSON.stringify(ir, null, 2));
    } catch (err) {
      console.error(chalk.red(`Compilation error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// validate command
program
  .command('validate <file>')
  .description('Validate .aflow file and show errors/warnings')
  .action((file: string) => {
    try {
      const ir = loadAndCompile(file);
      const result = validate(ir);

      for (const err of result.errors) {
        console.log(
          chalk.red(
            `❌ [${err.rule}]${err.phase ? ` [phase: ${err.phase}]` : ''}${err.agent ? ` [agent: ${err.agent}]` : ''} ${err.message}`,
          ),
        );
      }
      for (const warn of result.warnings) {
        console.log(
          chalk.yellow(
            `⚠️  [${warn.rule}]${warn.phase ? ` [phase: ${warn.phase}]` : ''}${warn.agent ? ` [agent: ${warn.agent}]` : ''} ${warn.message}`,
          ),
        );
      }

      if (result.ok) {
        const warnText =
          result.warnings.length > 0 ? ` — ${result.warnings.length} warning(s)` : '';
        console.log(chalk.green(`\n✅ Workflow valid${warnText}`));
      } else {
        console.log(
          chalk.red(
            `\n❌ Validation failed — ${result.errors.length} error(s), ${result.warnings.length} warning(s)`,
          ),
        );
        process.exit(1);
      }
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// check command
program
  .command('check <file>')
  .description('Check .aflow file: summary + errors + warnings')
  .action((file: string) => {
    try {
      const ir = loadAndCompile(file);
      const result = validate(ir);
      const w = ir.workflow;

      const agentCount = Object.keys(w.agents).length;
      const phaseCount = w.phases.length;
      const loopInfo = w.loop
        ? `Loop: ${w.loop.id} (max ${w.loop.max_iterations ?? '?'} iter.)`
        : 'no loop';

      console.log(chalk.bold(`\n📋 ${w.id}${w.version ? ` — v${w.version}` : ''}`));
      if (w.description) console.log(`   ${w.description}`);
      console.log(`   Agents: ${agentCount}  |  Phases: ${phaseCount}  |  ${loopInfo}\n`);

      for (const err of result.errors) {
        console.log(
          chalk.red(
            `❌ [${err.rule}]${err.phase ? ` [phase: ${err.phase}]` : ''}${err.agent ? ` [agent: ${err.agent}]` : ''} ${err.message}`,
          ),
        );
      }
      for (const warn of result.warnings) {
        console.log(
          chalk.yellow(
            `⚠️  [${warn.rule}]${warn.phase ? ` [phase: ${warn.phase}]` : ''}${warn.agent ? ` [agent: ${warn.agent}]` : ''} ${warn.message}`,
          ),
        );
      }

      if (result.ok) {
        const warnText =
          result.warnings.length > 0 ? ` — ${result.warnings.length} warning(s)` : '';
        console.log(chalk.green(`\n✅ Workflow valid${warnText}`));
      } else {
        console.log(
          chalk.red(
            `\n❌ Validation failed — ${result.errors.length} error(s), ${result.warnings.length} warning(s)`,
          ),
        );
        process.exit(1);
      }
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// build command
program
  .command('build <file>')
  .description('Compile and save IR JSON to disk')
  .action((file: string) => {
    try {
      const ir = loadAndCompile(file);
      const result = validate(ir);

      if (!result.ok) {
        for (const err of result.errors) {
          console.error(chalk.red(`❌ [${err.rule}] ${err.message}`));
        }
        console.error(chalk.red('\nBuild failed due to validation errors.'));
        process.exit(1);
      }

      const outFile = file.replace(/\.aflow$/, '.ir.json');
      writeFileSync(outFile, JSON.stringify(ir, null, 2));
      console.log(chalk.green(`✅ Built: ${outFile}`));
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// run command
program
  .command('run <file>')
  .description('Execute workflow with per-agent model resolution')
  .option('--input <json>', 'Trigger input as key=value pairs')
  .option('--mock', 'Force MockAgentExecutor even if ANTHROPIC_API_KEY is set')
  .option(
    '--approve-irreversible',
    'Allow execution of phases marked irreversible (money, deploys, deletions)',
  )
  .option(
    '--output-dir <dir>',
    'Directory for phase output files (default: ./output/<workflow-id>, or $AGENTFLOW_OUTPUT_DIR)',
  )
  .option(
    '--state-dir <dir>',
    'Directory for <uuid>.state.json files (default: CWD, or $AGENTFLOW_STATE_DIR)',
  )
  .action(
    async (
      file: string,
      options: {
        input?: string;
        mock?: boolean;
        outputDir?: string;
        stateDir?: string;
        approveIrreversible?: boolean;
      },
    ) => {
      if (!existsSync('agentflow.config.json')) {
        console.log(
          chalk.yellow('⚠️  agentflow.config.json not found — using built-in defaults.\n'),
        );
        console.log(chalk.dim('   Run "agentflow init" to customize models and providers.\n'));
      }

      try {
        const ir = loadAndCompile(file);
        const result = validate(ir);

        if (!result.ok) {
          for (const err of result.errors) {
            console.error(chalk.red(`❌ [${err.rule}] ${err.message}`));
          }
          process.exit(1);
        }

        // Parse trigger input
        const triggerInput: Record<string, unknown> = {};
        if (options.input) {
          const pairs = options.input.match(/(\w+)=("[^"]*"|[^\s]+)/g) ?? [];
          for (const pair of pairs) {
            const eqIdx = pair.indexOf('=');
            const key = pair.substring(0, eqIdx);
            let value: string = pair.substring(eqIdx + 1);
            if (value.startsWith('"') && value.endsWith('"')) {
              value = value.slice(1, -1);
            }
            triggerInput[key] = value;
          }
        }

        // Executor selection: per-agent model resolution
        const outputDir =
          options.outputDir ?? process.env.AGENTFLOW_OUTPUT_DIR ?? `./output/${ir.workflow.id}`;
        const stateDir = options.stateDir ?? process.env.AGENTFLOW_STATE_DIR;
        const toolRegistry = createBuiltinRegistry(resolve(outputDir));

        const executor = options.mock
          ? new MockAgentExecutor()
          : createExecutorResolver(toolRegistry);

        if (options.mock) console.log(chalk.yellow('⚠️  Executor: Mock\n'));
        else console.log(chalk.cyan('🔀 Executor: per-agent model resolution\n'));

        const runner = new WorkflowRunner(ir, executor, {
          outputDir,
          stateDir,
          approveIrreversible: options.approveIrreversible,
        });
        // SIGTERM/SIGINT (e.g. flow's timeout path) → checkpoint and stop cleanly.
        runner.enableGracefulShutdown();

        console.log(chalk.bold(`🚀 Running: ${ir.workflow.id}\n`));

        const instance = await runner.run(triggerInput);

        printResultsAndExit(instance, { file, command: 'run', outputDir, stateDir });
      } catch (err) {
        console.error(chalk.red(`Runtime error: ${(err as Error).message}`));
        process.exit(1);
      }
    },
  );

// resume command
program
  .command('resume <file>')
  .description('Resume a previously interrupted workflow instance from saved state')
  .option('--instance <uuid>', 'Instance ID to resume (required)')
  .option('--mock', 'Force MockAgentExecutor')
  .option(
    '--approve-irreversible',
    'Allow execution of phases marked irreversible (money, deploys, deletions)',
  )
  .option(
    '--output-dir <dir>',
    'Directory for phase output files (default: ./output/<workflow-id>, or $AGENTFLOW_OUTPUT_DIR)',
  )
  .option(
    '--state-dir <dir>',
    'Directory to load/save <uuid>.state.json (default: CWD, or $AGENTFLOW_STATE_DIR)',
  )
  .action(
    async (
      file: string,
      options: {
        instance?: string;
        mock?: boolean;
        outputDir?: string;
        stateDir?: string;
        approveIrreversible?: boolean;
      },
    ) => {
      if (!options.instance) {
        console.error(chalk.red('Error: --instance <uuid> is required for resume'));
        process.exit(1);
      }

      try {
        const ir = loadAndCompile(file);
        const result = validate(ir);

        if (!result.ok) {
          for (const err of result.errors) {
            console.error(chalk.red(`❌ [${err.rule}] ${err.message}`));
          }
          process.exit(1);
        }

        // Executor selection: per-agent model resolution
        const outputDir =
          options.outputDir ?? process.env.AGENTFLOW_OUTPUT_DIR ?? `./output/${ir.workflow.id}`;
        const stateDir = options.stateDir ?? process.env.AGENTFLOW_STATE_DIR;
        const toolRegistry = createBuiltinRegistry(resolve(outputDir));

        const executor = options.mock
          ? new MockAgentExecutor()
          : createExecutorResolver(toolRegistry);

        if (options.mock) console.log(chalk.yellow('⚠️  Executor: Mock\n'));
        else console.log(chalk.cyan('🔀 Executor: per-agent model resolution\n'));

        const runner = new WorkflowRunner(ir, executor, {
          outputDir,
          stateDir,
          approveIrreversible: options.approveIrreversible,
        });
        runner.enableGracefulShutdown();

        console.log(chalk.bold(`▶ Resuming: ${ir.workflow.id} — instance ${options.instance}\n`));

        const instance = await runner.resume(options.instance);

        printResultsAndExit(instance, { file, command: 'resume', outputDir, stateDir });
      } catch (err) {
        console.error(chalk.red(`Resume error: ${(err as Error).message}`));
        process.exit(1);
      }
    },
  );

// mcp-config command
program
  .command('mcp-config')
  .description('Print the MCP config JSON to add to Claude Code settings')
  .option('--workflows-dir <dir>', 'Directory containing .aflow files', process.cwd())
  .action((options: { workflowsDir: string }) => {
    // Load local .env if present
    if (existsSync('.env')) {
      const envContent = readFileSync('.env', 'utf-8');
      for (const line of envContent.split('\n')) {
        const match = line.match(/^([^=]+)=(.*)$/);
        if (match && !process.env[match[1]]) {
          process.env[match[1]] = match[2].trim();
        }
      }
    }

    const workflowsDir = resolve(options.workflowsDir);
    const env: Record<string, string> = {
      AGENTFLOW_WORKFLOWS_DIR: workflowsDir,
      OLLAMA_BASE_URL: 'http://localhost:11434',
    };
    if (process.env['ANTHROPIC_API_KEY'])
      env['ANTHROPIC_API_KEY'] = process.env['ANTHROPIC_API_KEY'];
    if (process.env['OPENROUTER_API_KEY'])
      env['OPENROUTER_API_KEY'] = process.env['OPENROUTER_API_KEY'];
    if (process.env['DEEPSEEK_API_KEY']) env['DEEPSEEK_API_KEY'] = process.env['DEEPSEEK_API_KEY'];

    const config = {
      mcpServers: {
        agentflow: {
          command: 'npx',
          args: ['-y', '--package=@anhonestboy/agentflow', 'agentflow-mcp'],
          env,
        },
      },
    };

    console.log(chalk.bold('\n📋 Add this to ~/.claude/settings.json under "mcpServers":\n'));
    console.log(JSON.stringify(config, null, 2));
    if (
      !process.env['ANTHROPIC_API_KEY'] &&
      !process.env['OPENROUTER_API_KEY'] &&
      !process.env['DEEPSEEK_API_KEY']
    ) {
      console.log(chalk.yellow('\n⚠️  No API keys found in .env — run "agentflow init" first.'));
    }
    console.log();
  });

// models command
program
  .command('models')
  .description('List configured models and test connectivity')
  .action(async () => {
    if (!existsSync('agentflow.config.json')) {
      console.log(chalk.yellow('⚠️  agentflow.config.json not found. Run first: agentflow init'));
      process.exit(1);
    }
    const raw = readFileSync('agentflow.config.json', 'utf-8');
    const config = JSON.parse(raw) as {
      models: Record<string, { provider: string; model?: string }>;
    };

    console.log(chalk.bold('\n🤖 Configured models:\n'));
    for (const [alias, cfg] of Object.entries(config.models)) {
      const label = `${alias}`.padEnd(20);
      const provider = cfg.provider.padEnd(12);
      const model = cfg.model ?? '(auto)';
      console.log(`   ${chalk.cyan(label)} ${chalk.dim(provider)} ${model}`);
    }

    // Connectivity checks
    console.log(chalk.bold('\n🔌 Connectivity:\n'));

    if (process.env.ANTHROPIC_API_KEY) {
      console.log(`   ${chalk.green('✅')} Claude (ANTHROPIC_API_KEY set)`);
    } else {
      console.log(`   ${chalk.dim('○')}  Claude (ANTHROPIC_API_KEY not set)`);
    }

    if (process.env.OPENROUTER_API_KEY) {
      console.log(`   ${chalk.green('✅')} OpenRouter (OPENROUTER_API_KEY set)`);
    } else {
      console.log(`   ${chalk.dim('○')}  OpenRouter (OPENROUTER_API_KEY not set)`);
    }

    if (process.env.DEEPSEEK_API_KEY) {
      console.log(`   ${chalk.green('✅')} DeepSeek (DEEPSEEK_API_KEY set)`);
    } else {
      console.log(`   ${chalk.dim('○')}  DeepSeek (DEEPSEEK_API_KEY not set)`);
    }

    try {
      const ollamaBase = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
      const res = await fetch(`${ollamaBase}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const data = (await res.json()) as { models: Array<{ name: string }> };
        console.log(
          `   ${chalk.green('✅')} Ollama (${data.models.length} models installed at ${ollamaBase})`,
        );
      } else {
        console.log(`   ${chalk.yellow('⚠️')}  Ollama (response ${res.status})`);
      }
    } catch {
      console.log(`   ${chalk.dim('○')}  Ollama (unreachable)`);
    }

    console.log();
  });

program.parse();
