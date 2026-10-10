import { simpleGit } from 'simple-git'

const MAX_CONCURRENT_CLONES = 5
const git = simpleGit({ maxConcurrentProcesses: MAX_CONCURRENT_CLONES })

export const clone = git.clone
