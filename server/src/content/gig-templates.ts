// Neon Dusk — Gig Template Seeds (ND-054 Data Seeding)
// ============================================================================
// 10 hand-crafted gig templates for MVP T1-T2.
// 6 × T1 (SC 0+), 4 × T2 (SC 5+).
// Types: 4 extraction, 3 delivery, 3 sabotage.
// Districts spread across: O Fluxo, A Paraíso, O Fervo, A Quebrada, Babilônia.
//
// Balance anchors (03-mecanicas-core.md §2, 04-sistemas-e-progressao.md §5):
//   T1 payout 500-1500, NIL 10-15, difficulty 30-55
//   T2 payout 2000-6000, NIL 15-25, difficulty 50-75
//   requiredStats achievable by optimized starting chars (max 8 T1, max 10 T2)
//
// cooldownMinutes is NOT included — the seed script derives it (T1=10, T2=25).

/** Static seed data for a gig template. */
export interface GigTemplateSeed {
  name: string;
  description: string;
  tier: 't1' | 't2';
  type: 'extraction' | 'delivery' | 'sabotage';
  district: string;
  difficulty: number;
  escapeDifficulty: number;
  requiredStats: Record<string, number>;
  requiredStreetCred: number;
  baseReward: number;
  nilCost: number;
  heatGenerated: number;
  legworkMinutes: number;
}

export const GIG_TEMPLATES: GigTemplateSeed[] = [
  // ═══ T1 — Street Level (SC 0+) ═══════════════════════════════════════════

  {
    name: "Encomenda Extraviada",
    description:
      "Um pacote caiu do drone de entrega da Concreta no telhado do bloco 7. " +
      "Os Filhos do Fluxo já estão farejando. Pega antes deles e entrega no ponto cego.",
    tier: "t1",
    type: "extraction",
    district: "O Fluxo",
    difficulty: 40,
    escapeDifficulty: 35,
    requiredStats: { body: 4 },
    requiredStreetCred: 0,
    baseReward: 800,
    nilCost: 12,
    heatGenerated: 15,
    legworkMinutes: 10,
  },
  {
    name: "Mula Noturna",
    description:
      "Leva este datachip através de 3 postos de controle da Polícia Corporativa " +
      "sem ser escaneado. Se te pararem, engole o chip. Sim, é sério.",
    tier: "t1",
    type: "delivery",
    district: "A Paraíso",
    difficulty: 45,
    escapeDifficulty: 40,
    requiredStats: { reflexes: 5, cool: 3 },
    requiredStreetCred: 0,
    baseReward: 1000,
    nilCost: 12,
    heatGenerated: 10,
    legworkMinutes: 15,
  },
  {
    name: "Curto-Circuito",
    description:
      "Os geradores do setor 4 precisam parar por exatamente 37 minutos. " +
      "Nem 36, nem 38. O sindicato quer mandar um recado e você é o mensageiro.",
    tier: "t1",
    type: "sabotage",
    district: "O Fervo",
    difficulty: 50,
    escapeDifficulty: 45,
    requiredStats: { technical: 5 },
    requiredStreetCred: 0,
    baseReward: 1200,
    nilCost: 14,
    heatGenerated: 20,
    legworkMinutes: 10,
  },
  {
    name: "Limpeza de Garagem",
    description:
      "Tem um Kadokami blindado estacionado no subsolo do shopping abandonado. " +
      "O dono virou carne moída na guerra de gangues. O carro é seu — se conseguir ligar ele.",
    tier: "t1",
    type: "extraction",
    district: "A Quebrada",
    difficulty: 55,
    escapeDifficulty: 50,
    requiredStats: { technical: 4, reflexes: 4 },
    requiredStreetCred: 0,
    baseReward: 1500,
    nilCost: 15,
    heatGenerated: 25,
    legworkMinutes: 15,
  },
  {
    name: "Corre da Farmácia",
    description:
      "O estoque de imunossupressores do beco 3 acabou e o próximo carregamento " +
      "só chega sexta. Leva esta caixa térmica até a clínica clandestina antes que alguém morra.",
    tier: "t1",
    type: "delivery",
    district: "Babilônia",
    difficulty: 30,
    escapeDifficulty: 30,
    requiredStats: { cool: 3 },
    requiredStreetCred: 0,
    baseReward: 500,
    nilCost: 10,
    heatGenerated: 5,
    legworkMinutes: 5,
  },
  {
    name: "Sucata Premiada",
    description:
      "Uma torre de servidor pré-Blackout foi localizada no ferro-velho do Alemão. " +
      "Os Saqueadores de Sucata já montaram guarda. Destrói a torre antes que extraiam os dados.",
    tier: "t1",
    type: "sabotage",
    district: "A Quebrada",
    difficulty: 35,
    escapeDifficulty: 40,
    requiredStats: { technical: 3, body: 3 },
    requiredStreetCred: 0,
    baseReward: 900,
    nilCost: 11,
    heatGenerated: 10,
    legworkMinutes: 10,
  },

  // ═══ T2 — Runner (SC 5+) ═════════════════════════════════════════════════

  {
    name: "Bagre Ensaboado",
    description:
      "Um engenheiro da Concreta quer desertar. O problema: ele está trancado " +
      "no laboratório 9 com lockdown biométrico ativo. Extrai ele antes que a segurança interna resolva o bug.",
    tier: "t2",
    type: "extraction",
    district: "A Paraíso",
    difficulty: 60,
    escapeDifficulty: 55,
    requiredStats: { body: 6, technical: 5 },
    requiredStreetCred: 5,
    baseReward: 3500,
    nilCost: 18,
    heatGenerated: 30,
    legworkMinutes: 20,
  },
  {
    name: "Linha Vermelha",
    description:
      "Transporta um carregamento de neuroestimulantes militares do Fervo até " +
      "o Ponto sem passar por nenhuma câmera da Polícia Corp. O trajeto tem 14 câmeras. Boa sorte.",
    tier: "t2",
    type: "delivery",
    district: "O Fervo",
    difficulty: 65,
    escapeDifficulty: 60,
    requiredStats: { reflexes: 7, cool: 5 },
    requiredStreetCred: 5,
    baseReward: 4000,
    nilCost: 20,
    heatGenerated: 35,
    legworkMinutes: 25,
  },
  {
    name: "Protocolo Cinzas",
    description:
      "A Aço Paulista está transferindo dados de projeto para um servidor offline. " +
      "Planta um vírus corrosivo na subnet de backup. Quando tentarem restaurar, não vai ter o que restaurar.",
    tier: "t2",
    type: "sabotage",
    district: "O Fluxo",
    difficulty: 70,
    escapeDifficulty: 65,
    requiredStats: { technical: 7, intelligence: 6 },
    requiredStreetCred: 5,
    baseReward: 5000,
    nilCost: 22,
    heatGenerated: 40,
    legworkMinutes: 30,
  },
  {
    name: "Olho por Olho",
    description:
      "O fixer Carcará quer um protótipo de retina sintética que está num " +
      "cofre biométrico no 47° andar da Torre Falcão. O cofre só abre com um olho vivo. Adivinha de quem?",
    tier: "t2",
    type: "extraction",
    district: "Babilônia",
    difficulty: 75,
    escapeDifficulty: 70,
    requiredStats: { body: 8, cool: 6, technical: 5 },
    requiredStreetCred: 5,
    baseReward: 6000,
    nilCost: 25,
    heatGenerated: 50,
    legworkMinutes: 30,
  },
];
