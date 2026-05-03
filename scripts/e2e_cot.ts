import { getCotReport } from '../src/tools/finance/get_cot_report.js';

const result = await getCotReport.invoke({ currency: 'JPY', weeks: 4 });
console.log('=== get_cot_report(JPY, 4) ===');
console.log(result);
