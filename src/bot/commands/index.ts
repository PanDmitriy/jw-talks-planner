/**
 * Регистрация всех команд бота
 */

import type { Telegraf } from 'telegraf';
import type { DatabaseInstance } from '../../db';
import type { AuthContext } from '../middlewares/auth';
import { registerStartCommand } from './start';
import { registerListCommand } from './list';
import { registerAddCommand } from './add';
import { registerEditCommand } from './edit';
import { registerDeleteCommand } from './delete';
import { registerStatsCommand } from './stats';
import { registerCongregationCommand } from './congregation';
import { registerPlansCommand } from './plans';
import { registerCheckCommand } from './check';

export function registerAllCommands(bot: Telegraf<AuthContext>, db: DatabaseInstance): void {
  registerStartCommand(bot, db);
  registerListCommand(bot, db);
  registerAddCommand(bot, db);
  registerEditCommand(bot, db);
  registerDeleteCommand(bot, db);
  registerStatsCommand(bot, db);
  registerCongregationCommand(bot, db);
  registerPlansCommand(bot, db);
  registerCheckCommand(bot, db);
}
