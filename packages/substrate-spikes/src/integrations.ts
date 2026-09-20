import type { Account, CrmCapability } from "@aao/substrate-contracts";

type ProviderAAccount = { account_id: string; display_name: string; quality_score: number };
type ProviderBAccount = { id: string; company: { name: string }; metrics: { score: number } };

export class FakeCRMAdapterA implements CrmCapability {
  constructor(private readonly records: ProviderAAccount[]) {}
  async searchAccounts(query: string): Promise<Account[]> {
    return this.records
      .filter((record) => record.display_name.toLowerCase().includes(query.toLowerCase()))
      .map((record) => ({ id: record.account_id, name: record.display_name, score: record.quality_score }));
  }
}

export class FakeCRMAdapterB implements CrmCapability {
  constructor(private readonly records: ProviderBAccount[]) {}
  async searchAccounts(query: string): Promise<Account[]> {
    return this.records
      .filter((record) => record.company.name.toLowerCase().includes(query.toLowerCase()))
      .map((record) => ({ id: record.id, name: record.company.name, score: record.metrics.score }));
  }
}

export async function findQualifiedAccounts(crm: CrmCapability, query: string): Promise<string[]> {
  return (await crm.searchAccounts(query))
    .filter((account) => account.score >= 80)
    .map((account) => account.name);
}
