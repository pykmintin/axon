import { create } from 'zustand';
import type {
  CouplingPair,
  CypherEntry,
  CypherResult,
  DeadCodeReport,
  HealthScore,
  ImpactResult,
  NodeContext,
  Process,
} from '@/types';

interface DataStore {
  // Node detail
  nodeContext: NodeContext | null;
  impactResult: ImpactResult | null;
  fileContent: { path: string; content: string; language: string } | null;
  nodeProcesses: Process[] | null;

  // Analysis data
  healthScore: HealthScore | null;
  deadCode: DeadCodeReport | null;
  couplingData: CouplingPair[] | null;
  allProcesses: Process[] | null;

  // Cypher
  cypherHistory: CypherEntry[];
  cypherResult: CypherResult | null;

  // Loading states
  loading: Record<string, boolean>;

  // Actions
  setNodeContext: (ctx: NodeContext | null) => void;
  setImpactResult: (result: ImpactResult | null) => void;
  setFileContent: (content: { path: string; content: string; language: string } | null) => void;
  setNodeProcesses: (processes: Process[] | null) => void;
  setHealthScore: (score: HealthScore | null) => void;
  setDeadCode: (report: DeadCodeReport | null) => void;
  setCouplingData: (data: CouplingPair[] | null) => void;
  setAllProcesses: (processes: Process[] | null) => void;
  setCypherResult: (result: CypherResult | null) => void;
  addCypherHistory: (query: string) => void;
  setLoading: (key: string, value: boolean) => void;
}

export const useDataStore = create<DataStore>((set) => ({
  nodeContext: null,
  impactResult: null,
  fileContent: null,
  nodeProcesses: null,
  healthScore: null,
  deadCode: null,
  couplingData: null,
  allProcesses: null,
  cypherHistory: JSON.parse(localStorage.getItem('axon-cypher-history') || '[]'),
  cypherResult: null,
  loading: {},

  setNodeContext: (ctx) => set({ nodeContext: ctx }),
  setImpactResult: (result) => set({ impactResult: result }),
  setFileContent: (content) => set({ fileContent: content }),
  setNodeProcesses: (processes) => set({ nodeProcesses: processes }),
  setHealthScore: (score) => set({ healthScore: score }),
  setDeadCode: (report) => set({ deadCode: report }),
  setCouplingData: (data) => set({ couplingData: data }),
  setAllProcesses: (processes) => set({ allProcesses: processes }),
  setCypherResult: (result) => set({ cypherResult: result }),
  addCypherHistory: (query) => set((s) => {
    const entry: CypherEntry = { query, timestamp: Date.now() };
    const history = [entry, ...s.cypherHistory].slice(0, 20);
    localStorage.setItem('axon-cypher-history', JSON.stringify(history));
    return { cypherHistory: history };
  }),
  setLoading: (key, value) => set((s) => ({
    loading: { ...s.loading, [key]: value },
  })),
}));
