/**
 * The reference vehicle manufacturing line.
 *
 * TOPOLOGY (requirement 1). Built exactly as specified in the project brief:
 *
 *   Parts/Material Receiving -> Body Manufacturing -> Body Shop -> Paint Shop
 *     -> Powertrain Installation -> Interior Installation
 *     -> Electrical Installation -> Final Assembly -> Quality Inspection
 *          |-- PASS  -> Finished Vehicle
 *          |-- FAIL  -> Rework -> Quality Inspection
 *          |-- SCRAP -> Scrapped
 *
 * The brief states the topology must follow the project's approved network
 * diagram "once provided". That diagram was not available when this model was
 * written, so this is the brief's own stated flow, and every station, arc and
 * probability is editable at runtime — re-pointing the model at the approved
 * diagram is a configuration change, not a code change.
 *
 * DATA PROVENANCE (requirements 46 and 60). Every numeric default below is
 * marked PROJECT_ASSUMPTION. They are internally consistent and chosen to
 * produce a plausible, instructive factory; they are NOT claims about any real
 * manufacturer, and nothing here should be cited as an industry figure. Where
 * a parameter is later replaced with a sourced value, its provenance becomes
 * SOURCE_BACKED and `source` is filled in — the UI renders the two differently
 * so the distinction is always visible.
 *
 * MODELLING NOTE ON SCALE. A real vehicle plant has hundreds of workstations
 * and a few thousand operators. This model compresses that into ten stations,
 * so headcount and labour cost per vehicle are lower than published
 * whole-plant figures. The abstraction is deliberate and is recorded in
 * `assumptions` so it appears in the generated report.
 */

import { param, SINK_FINISHED, SINK_SCRAP, type BomComponent, type Station, type SystemModel, type VehicleModel } from './types.js';
import { defaultCurrency, makeCrew, makeMachine } from './defaults.js';

const A = 'PROJECT_ASSUMPTION' as const;

/* ------------------------------------------------------------------ */
/* Stations                                                            */
/* ------------------------------------------------------------------ */

function stations(): Station[] {
  return [
    {
      id: 'parts_receiving',
      name: 'Parts / Material Receiving',
      kind: 'source',
      description:
        'Kitting and staging of purchased components. Vehicles (as job orders) enter the ' +
        'system here, which is the only point where external lambda is defined.',
      servers: 2,
      queueDiscipline: 'FIFO',
      queueCapacity: null,
      service: { kind: 'exponential', mean: 8 },
      workers: [makeCrew('pr_op', 'Operator', 4, 24), makeCrew('pr_sup', 'Supervisor', 1, 38)],
      machine: makeMachine('mh_forklift', 'Material handling / AGV set', {
        purchasePrice: 180_000,
        usefulLifeYears: 8,
        annualOperatingHours: 2000,
        powerKw: 18,
        idlePowerKw: 3,
        maintenanceCostPerHour: 6,
        consumablesCostPerHour: 2,
      }),
      routing: [{ to: 'body_manufacturing', probability: 1, label: 'to body manufacturing' }],
      scrapProbability: 0,
    },
    {
      id: 'body_manufacturing',
      name: 'Body Manufacturing',
      kind: 'process',
      description: 'Stamping and forming of body panels from coil steel and aluminium.',
      servers: 3,
      queueDiscipline: 'FIFO',
      queueCapacity: null,
      service: { kind: 'exponential', mean: 22 },
      workers: [makeCrew('bm_op', 'Operator', 9, 27), makeCrew('bm_tech', 'Technician', 2, 34)],
      machine: makeMachine('mach_press', 'Stamping press line', {
        purchasePrice: 1_900_000,
        usefulLifeYears: 12,
        salvageValue: 150_000,
        annualOperatingHours: 2000,
        powerKw: 380,
        idlePowerKw: 45,
        maintenanceCostPerHour: 32,
        consumablesCostPerHour: 18,
        reliabilityEnabled: true,
        mtbfHours: 180,
        mttrHours: 2.5,
        repairCostPerHour: 140,
      }),
      routing: [{ to: 'body_shop', probability: 1, label: 'to body shop' }],
      scrapProbability: 0,
    },
    {
      id: 'body_shop',
      name: 'Body Shop',
      kind: 'process',
      description: 'Robotic welding and joining of the body-in-white.',
      servers: 3,
      queueDiscipline: 'FIFO',
      queueCapacity: null,
      service: { kind: 'exponential', mean: 24 },
      workers: [makeCrew('bs_op', 'Operator', 8, 28), makeCrew('bs_tech', 'Technician', 3, 35)],
      machine: makeMachine('mach_weld', 'Robotic welding cell', {
        purchasePrice: 1_600_000,
        usefulLifeYears: 12,
        salvageValue: 120_000,
        annualOperatingHours: 2000,
        powerKw: 320,
        idlePowerKw: 55,
        maintenanceCostPerHour: 30,
        consumablesCostPerHour: 21,
        reliabilityEnabled: true,
        mtbfHours: 160,
        mttrHours: 2,
        repairCostPerHour: 150,
      }),
      routing: [{ to: 'paint_shop', probability: 1, label: 'to paint' }],
      scrapProbability: 0,
    },
    {
      id: 'paint_shop',
      name: 'Paint Shop',
      kind: 'process',
      description:
        'Pre-treatment, e-coat, primer, base coat and clear coat. Highest utilisation ' +
        'station in the default configuration — the line bottleneck.',
      servers: 3,
      queueDiscipline: 'FIFO',
      queueCapacity: null,
      service: { kind: 'exponential', mean: 28 },
      workers: [makeCrew('ps_op', 'Operator', 6, 29), makeCrew('ps_tech', 'Technician', 3, 36)],
      machine: makeMachine('mach_booth', 'Paint booth + oven', {
        purchasePrice: 2_400_000,
        usefulLifeYears: 10,
        salvageValue: 200_000,
        annualOperatingHours: 2000,
        powerKw: 450,
        idlePowerKw: 120,
        maintenanceCostPerHour: 38,
        consumablesCostPerHour: 22,
        reliabilityEnabled: true,
        mtbfHours: 150,
        mttrHours: 3,
        repairCostPerHour: 165,
      }),
      routing: [{ to: 'powertrain', probability: 1, label: 'to powertrain' }],
      scrapProbability: 0,
    },
    {
      id: 'powertrain',
      name: 'Powertrain Installation',
      kind: 'process',
      description: 'Engine, transmission and exhaust marriage to the painted body.',
      servers: 3,
      queueDiscipline: 'FIFO',
      queueCapacity: null,
      service: { kind: 'exponential', mean: 25 },
      workers: [makeCrew('pt_op', 'Operator', 10, 30), makeCrew('pt_tech', 'Technician', 2, 37)],
      machine: makeMachine('mach_marriage', 'Powertrain marriage station', {
        purchasePrice: 900_000,
        usefulLifeYears: 12,
        annualOperatingHours: 2000,
        powerKw: 95,
        idlePowerKw: 14,
        maintenanceCostPerHour: 18,
        consumablesCostPerHour: 9,
      }),
      routing: [{ to: 'interior', probability: 1, label: 'to interior' }],
      scrapProbability: 0,
    },
    {
      id: 'interior',
      name: 'Interior Installation',
      kind: 'process',
      description: 'Seats, trim, glass, headliner and carpet.',
      servers: 3,
      queueDiscipline: 'FIFO',
      queueCapacity: null,
      service: { kind: 'exponential', mean: 20 },
      workers: [makeCrew('in_op', 'Operator', 12, 26)],
      machine: makeMachine('mach_interior', 'Interior fitting line + hoists', {
        purchasePrice: 520_000,
        usefulLifeYears: 12,
        annualOperatingHours: 2000,
        powerKw: 42,
        idlePowerKw: 8,
        maintenanceCostPerHour: 11,
        consumablesCostPerHour: 6,
      }),
      routing: [{ to: 'electrical', probability: 1, label: 'to electrical' }],
      scrapProbability: 0,
    },
    {
      id: 'electrical',
      name: 'Electrical Installation',
      kind: 'process',
      description: 'Wiring harness, ECUs, battery and infotainment; module flashing.',
      servers: 2,
      queueDiscipline: 'FIFO',
      queueCapacity: null,
      service: { kind: 'exponential', mean: 16 },
      workers: [makeCrew('el_op', 'Operator', 6, 29), makeCrew('el_tech', 'Technician', 2, 38)],
      machine: makeMachine('mach_flash', 'Module programming / test rig', {
        purchasePrice: 340_000,
        usefulLifeYears: 8,
        annualOperatingHours: 2000,
        powerKw: 28,
        idlePowerKw: 9,
        maintenanceCostPerHour: 9,
        consumablesCostPerHour: 4,
      }),
      routing: [{ to: 'final_assembly', probability: 1, label: 'to final assembly' }],
      scrapProbability: 0,
    },
    {
      id: 'final_assembly',
      name: 'Final Assembly',
      kind: 'process',
      description:
        'Wheels, brakes, lighting, suspension, fluids and closures. Modelled as Erlang-2 ' +
        'rather than exponential: paced line work has noticeably lower variability than ' +
        'a memoryless service time, and the Kendall notation reflects that.',
      servers: 4,
      queueDiscipline: 'FIFO',
      queueCapacity: null,
      service: { kind: 'erlang', k: 2, mean: 30 },
      workers: [makeCrew('fa_op', 'Operator', 16, 28), makeCrew('fa_sup', 'Supervisor', 2, 40)],
      machine: makeMachine('mach_assembly', 'Final assembly line + torque tooling', {
        purchasePrice: 1_100_000,
        usefulLifeYears: 12,
        annualOperatingHours: 2000,
        powerKw: 110,
        idlePowerKw: 20,
        maintenanceCostPerHour: 20,
        consumablesCostPerHour: 12,
      }),
      routing: [{ to: 'inspection', probability: 1, label: 'to inspection' }],
      scrapProbability: 0,
    },
    {
      id: 'inspection',
      name: 'Quality Inspection',
      kind: 'inspection',
      description:
        'End-of-line inspection: dimensional, electrical, road-test and water test. ' +
        'The FAIL arc is an ordinary routing probability, which is what puts the rework ' +
        'feedback loop into the traffic equations.',
      servers: 2,
      queueDiscipline: 'FIFO',
      queueCapacity: null,
      service: { kind: 'exponential', mean: 12 },
      workers: [makeCrew('qi_insp', 'Inspector', 5, 33)],
      machine: makeMachine('mach_test', 'Test rig / roller dynamometer', {
        purchasePrice: 620_000,
        usefulLifeYears: 10,
        annualOperatingHours: 2000,
        powerKw: 60,
        idlePowerKw: 12,
        maintenanceCostPerHour: 15,
        consumablesCostPerHour: 5,
      }),
      routing: [
        { to: SINK_FINISHED, probability: 0.88, label: 'PASS' },
        { to: 'rework', probability: 0.1, label: 'FAIL - rework' },
        { to: SINK_SCRAP, probability: 0.02, label: 'SCRAP' },
      ],
      scrapProbability: 0,
    },
    {
      id: 'rework',
      name: 'Rework',
      kind: 'rework',
      description:
        'Defect correction. Every reworked vehicle returns to inspection, so a vehicle ' +
        'can loop more than once. Rework consumes labour, machine time, energy and ' +
        'material over and above the original build.',
      servers: 1,
      queueDiscipline: 'FIFO',
      queueCapacity: null,
      service: { kind: 'exponential', mean: 35 },
      workers: [makeCrew('rw_tech', 'Technician', 3, 36)],
      machine: makeMachine('mach_rework', 'Rework bay tooling', {
        purchasePrice: 210_000,
        usefulLifeYears: 10,
        annualOperatingHours: 2000,
        powerKw: 24,
        idlePowerKw: 5,
        maintenanceCostPerHour: 8,
        consumablesCostPerHour: 14,
      }),
      routing: [{ to: 'inspection', probability: 1, label: 're-inspect' }],
      scrapProbability: 0,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Bill of materials (requirement 14)                                  */
/* ------------------------------------------------------------------ */

function bom(): BomComponent[] {
  const c = (
    id: string,
    name: string,
    quantityPerVehicle: number,
    unit: string,
    unitCost: number,
    consumedAtStationId: string,
    scrapAllowance: number,
    supplier?: string,
  ): BomComponent => ({
    id,
    name,
    quantityPerVehicle,
    unit,
    unitCost: param(unitCost, `currency/${unit}`, A),
    supplier,
    scrapAllowance,
    consumedAtStationId,
  });

  return [
    c('steel', 'Steel body panels (coil)', 380, 'kg', 1.1, 'body_manufacturing', 0.06, 'Supplier A'),
    c('aluminium', 'Aluminium closures & castings', 60, 'kg', 2.6, 'body_manufacturing', 0.05, 'Supplier A'),
    c('weld_consumables', 'Weld wire, adhesives & sealer', 1, 'set', 145, 'body_shop', 0.02, 'Supplier B'),
    c('paint', 'Paint, primer & clear coat', 12, 'L', 18, 'paint_shop', 0.08, 'Supplier C'),
    c('engine', 'Engine assembly', 1, 'unit', 3200, 'powertrain', 0.005, 'Powertrain plant'),
    c('transmission', 'Transmission', 1, 'unit', 1750, 'powertrain', 0.005, 'Supplier D'),
    c('exhaust', 'Exhaust system & catalyst', 1, 'set', 260, 'powertrain', 0.01, 'Supplier D'),
    c('seats', 'Seat set', 5, 'unit', 210, 'interior', 0.01, 'Supplier E'),
    c('trim', 'Interior trim, carpet & headliner', 1, 'set', 640, 'interior', 0.02, 'Supplier E'),
    c('glass', 'Glazing set (windscreen, side, rear)', 1, 'set', 320, 'interior', 0.03, 'Supplier F'),
    c('harness', 'Wiring harness', 1, 'unit', 480, 'electrical', 0.01, 'Supplier G'),
    c('ecu', 'ECU / electronics set', 1, 'set', 1150, 'electrical', 0.005, 'Supplier G'),
    c('battery', '12V battery', 1, 'unit', 120, 'electrical', 0.01, 'Supplier H'),
    c('tires', 'Tyres', 4, 'unit', 95, 'final_assembly', 0.01, 'Supplier I'),
    c('wheels', 'Wheels', 4, 'unit', 130, 'final_assembly', 0.01, 'Supplier I'),
    c('brakes', 'Brake system', 1, 'set', 540, 'final_assembly', 0.005, 'Supplier J'),
    c('suspension', 'Suspension set', 1, 'set', 720, 'final_assembly', 0.005, 'Supplier J'),
    c('lights', 'Lighting set', 1, 'set', 310, 'final_assembly', 0.01, 'Supplier K'),
    c('fluids', 'Fluids, fasteners & consumables', 1, 'set', 180, 'final_assembly', 0.03, 'Supplier L'),
    // Consumed at the REWORK station, so it is charged once per rework visit and
    // lands in the Rework cost line rather than in direct material. A vehicle
    // that loops twice pays for it twice, which is what makes the rework cost
    // genuinely incremental (requirement 22).
    c('rework_kit', 'Rework materials & refinish kit', 1, 'set', 175, 'rework', 0, 'Various'),
  ];
}

function vehicleModels(): VehicleModel[] {
  return [
    {
      id: 'model_a',
      name: 'Model A - Compact Sedan',
      bom: bom(),
      sellingPrice: param(16_800, 'currency/vehicle', A, {
        notes:
          'Ex-factory transfer price assumed for the model. Not a market price for any ' +
          'real vehicle; edit to match the scenario being studied.',
      }),
      notes: 'The single vehicle model in the default configuration.',
    },
  ];
}

/* ------------------------------------------------------------------ */
/* The model                                                           */
/* ------------------------------------------------------------------ */

export const REFERENCE_MODEL_ID = 'reference-line-v1';

export function buildReferenceModel(): SystemModel {
  return {
    id: REFERENCE_MODEL_ID,
    name: 'Reference Vehicle Assembly Line',
    description:
      'Ten-station vehicle manufacturing line with an inspection/rework feedback loop, ' +
      'as specified in the project brief.',
    stations: stations(),
    arrivals: {
      entryStationId: 'parts_receiving',
      interarrivalKind: 'exponential',
      modelMix: [{ modelId: 'model_a', share: 1 }],
      // Requirement 36: a time-of-day demand schedule over one 8-hour shift.
      // Requirement 7: this is the ONLY place an external lambda is defined.
      schedule: [
        {
          startMinute: 0,
          endMinute: 120,
          lambdaPerHour: param(5, 'vehicles/hour', A),
          label: '08:00-10:00 shift start ramp',
        },
        {
          startMinute: 120,
          endMinute: 240,
          lambdaPerHour: param(7, 'vehicles/hour', A),
          label: '10:00-12:00 morning peak',
        },
        {
          startMinute: 240,
          endMinute: 360,
          lambdaPerHour: param(4, 'vehicles/hour', A),
          label: '12:00-14:00 break coverage',
        },
        {
          startMinute: 360,
          endMinute: 480,
          lambdaPerHour: param(7, 'vehicles/hour', A),
          label: '14:00-16:00 afternoon peak',
        },
        {
          startMinute: 480,
          endMinute: 600,
          lambdaPerHour: param(5, 'vehicles/hour', A),
          label: '16:00-18:00 shift end',
        },
      ],
    },
    vehicleModels: vehicleModels(),
    cost: {
      currency: defaultCurrency(),
      electricityPricePerKwh: param(0.085, 'currency/kWh', A, {
        notes:
          'Industrial tariff assumed for the model. Replace with the plant’s contracted ' +
          'rate and mark the parameter SOURCE_BACKED with that contract as the source.',
      }),
      waitingCostPerVehicleHour: param(45, 'currency/vehicle-hour', A, {
        notes:
          'Opportunity cost of a vehicle-hour spent queueing: tied-up working capital plus ' +
          'delayed revenue. This is a decision-support figure, not an accounting cost, and ' +
          'is reported separately from manufacturing cost (requirement 25).',
      }),
      wipHoldingCostPerVehicleHour: param(18, 'currency/vehicle-hour', A, {
        notes: 'Inventory carrying cost applied to average WIP.',
      }),
      laborCostBasis: 'scheduled',
      overhead: {
        mode: 'perHour',
        amount: param(4800, 'currency/hour', A),
        breakdown: [
          { id: 'rent', name: 'Factory rent & facilities', amount: param(1500, 'currency/hour', A) },
          { id: 'utilities', name: 'Non-process utilities (HVAC, lighting, air)', amount: param(900, 'currency/hour', A) },
          { id: 'admin', name: 'Administration & finance', amount: param(750, 'currency/hour', A) },
          { id: 'insurance', name: 'Insurance', amount: param(420, 'currency/hour', A) },
          { id: 'supervision', name: 'Plant supervision & management', amount: param(680, 'currency/hour', A) },
          { id: 'it', name: 'IT & systems', amount: param(330, 'currency/hour', A) },
          { id: 'security', name: 'Security & compliance', amount: param(220, 'currency/hour', A) },
        ],
      },
      preventiveMaintenancePerMachineHour: param(6, 'currency/machine-hour', A, {
        notes:
          'Scheduled maintenance charged against every machine-hour of availability, ' +
          'separate from the corrective repair cost incurred on a breakdown.',
      }),
    },
    simulation: {
      seed: 12345,
      replications: 10,
      // Mean manufacturing time is around four hours, so a 60-minute warm-up
      // would leave the factory still filling when measurement began. One full
      // 10-hour demand cycle is used to warm up, and four cycles are measured:
      // long enough for stable statistics while still exercising the whole
      // time-of-day demand schedule.
      warmupMinutes: 600,
      durationMinutes: 2400,
      // 'drain' stops new arrivals at the horizon and lets the vehicles already
      // on the line finish, so the measured cohort completes and neither
      // throughput nor mean cycle time is censored.
      terminationMode: 'drain',
      collectVehicleTraces: true,
      maxTraces: 500,
    },
    investment: {
      initialInvestment: param(0, 'currency', 'USER_INPUT', {
        notes: 'Set by the scenario being evaluated. Zero means "no capital change".',
      }),
      additionalAnnualOperatingCost: param(0, 'currency/year', 'USER_INPUT'),
      operatingDaysPerYear: param(250, 'days/year', A, {
        notes: 'Five-day week over 50 working weeks.',
      }),
      hoursPerDay: param(8, 'hours/day', A, { notes: 'One production shift per day.' }),
      items: [],
    },
    assumptions: [
      'Every default numeric value in this model is a PROJECT ASSUMPTION, not a sourced ' +
        'industry figure. They are internally consistent and chosen to produce an instructive ' +
        'factory; none should be quoted as a real manufacturer’s data.',
      'The line is compressed to ten stations. A real vehicle plant has hundreds of ' +
        'workstations and a few thousand operators, so labour cost per vehicle here is lower ' +
        'than published whole-plant figures.',
      'Service times are exponential except Final Assembly, which is Erlang-2 because paced ' +
        'line work has lower variability than a memoryless service time. The Kendall notation ' +
        'shown for each station is derived from its configured distribution.',
      'Transport time between stations is zero: a vehicle leaving one station joins the next ' +
        'station’s queue at the same instant. Conveyor time would add a constant to cycle time ' +
        'without changing queueing behaviour.',
      'Queues are unbounded by default, so no station blocks its upstream neighbour. Setting a ' +
        'finite queue capacity turns excess arrivals into rejections rather than blocking.',
      'Inspection failure sends a vehicle to rework and then back to inspection, so a vehicle ' +
        'may be inspected several times. The expected number of inspections per vehicle is ' +
        '1/(1 - p_fail).',
      'Machine failure is preemptive-resume: work already completed on a vehicle is preserved ' +
        'and the remainder finishes after the repair.',
      'Machine MTBF is measured in OPERATING hours, so a machine only ages while it is ' +
        'processing.',
      'Labour is charged on a scheduled basis: crews are paid for the shift whether busy or ' +
        'idle. Idle labour cost is reported separately so the waste is visible.',
    ],
    sources: [],
  };
}
