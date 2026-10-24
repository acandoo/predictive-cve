import pLimit from 'p-limit'
import { simpleGit } from 'simple-git'

import { MAX_CONCURRENT_CLONES } from './constants.ts'

const git = simpleGit()
const limit = pLimit(MAX_CONCURRENT_CLONES)

export const clone = (
  path: string,
  localPath: string,
  options?: any[]
): Promise<void> =>
  limit(async () => void (await git.clone(path, localPath, options)))
