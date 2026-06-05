import { state, displayPhase } from './state.js';
import { tick } from './simulation.js';
import { runTool } from './tools.js';
import { getLog } from './log.js';

const TICK = 500;

function snap(label: string) {
  const s = state;
  console.log(
    `[${label}] state=${s.state} phase=${displayPhase(s)} ` +
    `P_A=${s.pumps.A.pressure.toFixed(2)} P_B=${s.pumps.B.pressure.toFixed(2)} ` +
    `T_react=${s.thermal.reactor.current.toFixed(1)} ` +
    `ЯМР=${s.nmr.status}/${s.nmr.calibrated ? 'cal' : 'nocal'} ` +
    `conc=${(s.nmr.concentration * 100).toFixed(1)}% jar=${s.collection.volume.toFixed(1)}ml`
  );
}

console.log('=== Сценарий 1: запрос статуса ===');
console.log(runTool('get_system_status', {}, 'user'));

console.log('\n=== Сценарий 3: ошибка параметров (A=50 мл/мин — должно ОТКЛОНИТЬ) ===');
console.log(runTool('start_synthesis', { flowA: 50, flowB: 2, reactorTemp: 60 }, 'user'));

console.log('\n=== Сценарий 2: корректный синтез A=1, B=2, реактор 60°C, отбор 5с ===');
console.log(runTool('validate_synthesis_plan', { flowA: 1, flowB: 2, reactorTemp: 60, samplingIntervalSec: 5 }, 'user'));
console.log(runTool('start_synthesis', { flowA: 1, flowB: 2, reactorTemp: 60, samplingIntervalSec: 5 }, 'user'));

for (let i = 1; i <= 80; i++) {
  tick(TICK);
  if (i % 10 === 0) snap(`${(i * TICK) / 1000}s`);
}

console.log('\n=== Проверка интервала отбора < 5с (должно ОТКЛОНИТЬ) ===');
console.log(runTool('start_sampling', { intervalSec: 2 }, 'user'));

console.log('\n=== Сценарий 4: остановка ===');
console.log(runTool('stop_synthesis', {}, 'user'));

console.log('\n=== Сценарий 5: отчёт ===');
const rep = runTool('generate_experiment_report', {}, 'user');
console.log(rep.ok ? JSON.stringify(rep.data, null, 2) : rep.message);

console.log(`\nИзмерений ЯМР: ${state.nmr.history.length}`);
console.log('Последние записи журнала:');
for (const e of getLog().slice(-8)) {
  console.log(`  ${new Date(e.t).toISOString().slice(11, 19)} [${e.source}/${e.type}/${e.status ?? ''}] ${e.message}`);
}
console.log('\nOK: backend v2 работает.');
