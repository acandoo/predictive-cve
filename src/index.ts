import { Command } from 'commander'

import { scrapeData } from './scrape.ts'

const program = new Command()

program
  .name('predictive-cve')
  .description('CLI to train and predict CVEs')
  .version('0.1.0')

program
  .command('scrape')
  .description('Scrape data for the model')
  .action(scrapeData)

program.parse()
