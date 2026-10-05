import type { ToolSet } from 'ai';
import { screenTools } from './screen/tools';
import { browserTools } from './browser/tools';
import { nativeTools } from './native/tools';

export const tools: ToolSet = { ...screenTools, ...browserTools, ...nativeTools };
