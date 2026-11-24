import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DECISION_MODELS, decisionProviderForConnection, type DecisionConnectionChoice, type DecisionModelSettings, type DecisionProvider, type DecisionResult, type UpdateDecisionModel } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { decisionModelsApi } from "@/api/decision-models";
import { describeError } from "@/api/errors";
import { QueryErrorState, QueryPlaceholder, useQueryView } from "@/components/QueryView";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ToggleField } from "@/components/agent-config-primitives";
import { InlineBanner } from "@/components/InlineBanner";
import { AiProviderSetup } from "@/components/ai-connections/AiProviderSetup";
import { ConnectionChoiceList } from "@/features/connections/ConnectionChoiceList";
import { ConnectionSetupFlow } from "@/features/connections/ConnectionSetupFlow";
import { AppLogo } from "@/pages/apps/AppLogo";

const DECISION_PROVIDER_PRESENTATION: Record<DecisionProvider, { name: string; brandKey: string; serviceSlug: string; aiProvider: "openai" | "openrouter" }> = {
  openai: { name: "OpenAI", brandKey: "openai", serviceSlug: "openai", aiProvider: "openai" },
  openrouter: { name: "OpenRouter", brandKey: "openrouter", serviceSlug: "openrouter", aiProvider: "openrouter" },
  ollama: { name: "Ollama (local)", brandKey: "ollama", serviceSlug: "local", aiProvider: "openai" },
};

const INCOMPATIBLE_CONNECTION_NOTICES: Record<DecisionProvider, string> = {
  openai: "This connection can't be used for decisions. Decisions need a shared OpenAI API key connection.",
  openrouter: "This connection can't be used for decisions. Decisions need a shared OpenRouter API key connection.",
  ollama: "This connection can't be used for decisions. Local Ollama decisions need a shared connection with no authentication.",
};

function presentationForChoice(choice: DecisionConnectionChoice) {
  return DECISION_PROVIDER_PRESENTATION[decisionProviderForConnection(choice) ?? "openai"];
}

const failureMessages: Record<string, string> = {
  not_configured: "Choose and save a connection first.", disabled: "Enable and save decisions before running a test.",
  connection_unavailable: "The connection is unavailable. Reconnect it and try again.",
  access_denied: "This connection is not shared with you. Review its permissions.",
  incompatible_connection: "Choose a supported OpenAI, OpenRouter, or local Ollama connection.",
  budget_blocked: "The company or task budget prevents this request. Review Costs and Budgets.",
  provider_auth_failed: "The provider rejected the connection. Reconnect it and try again.",
  provider_rate_limited: "The provider is rate limited. Try again later.",
  timeout: "The decision timed out. Any provider charge appears in Costs.",
  refused: "The model declined the test. Review the connection and try again.",
};
export function DecisionModelSettingsView({ settings, choices, saving, testing, error, result, newlyConnectedId, incompatibleNotice, onSave, onTest, onAdd }: {
  settings: DecisionModelSettings; choices: DecisionConnectionChoice[]; saving?: boolean; testing?: boolean;
  error?: string | null; result?: DecisionResult | null; newlyConnectedId?: string | null;
  incompatibleNotice?: string | null;
  onSave: (value: UpdateDecisionModel) => void; onTest: () => void; onAdd: () => void;
}) {
  const [draft, setDraft] = useState<Required<UpdateDecisionModel>>(settings);
  const appliedConnection = useRef<string | null>(null);
  useEffect(() => { setDraft(settings); }, [settings.companyId, settings.connectionId, settings.grantId, settings.enabled, settings.allowBackground]);
  useEffect(() => {
    if (!newlyConnectedId) { appliedConnection.current = null; return; }
    if (appliedConnection.current === newlyConnectedId) return;
    const connection = choices.find(row => row.id === newlyConnectedId);
    if (connection) {
      appliedConnection.current = newlyConnectedId;
      setDraft(value => ({ ...value, connectionId: connection.id, grantId: connection.grantId, enabled: value.connectionId ? value.enabled : true }));
    }
  }, [newlyConnectedId, choices]);
  const selected = choices.find(row => row.grantId === draft.grantId);
  const dirty = draft.enabled !== settings.enabled || draft.allowBackground !== settings.allowBackground || draft.grantId !== settings.grantId;
  const unavailable = result && result.status !== "succeeded" ? failureMessages[result.status === "unavailable" ? result.reason : result.errorCode] ?? "The decision could not be completed. Review its entry in Costs." : null;
  return <section aria-labelledby="decision-model-heading" className="max-w-2xl space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="decision-model-heading" className="text-lg font-semibold">Decision model</h2>
      <Link to="/activity/costs?tab=decisions" className="text-sm underline underline-offset-4">View usage</Link>
    </div>
    <p className="text-sm text-muted-foreground">Choose the shared connection Paperclip uses for optional decision features. Usage may incur a provider charge on this connection.</p>
    <ConnectionChoiceList selectedId={draft.grantId ?? undefined} disabled={saving || testing}
      choices={choices.map(row => ({ id: row.grantId, name: row.name,
        description: `${row.decisionModel} · ${row.status === "connected" ? "Connected" : "Needs attention"}`,
        icon: <AppLogo name={presentationForChoice(row).name} brandKey={presentationForChoice(row).brandKey} size={24} />,
      }))}
      onSelect={grantId => { const row = choices.find(choice => choice.grantId === grantId)!; setDraft(value => ({ ...value, connectionId: row.id, grantId, enabled: value.connectionId ? value.enabled : true })); }} />
    {choices.length === 0 && <p className="text-sm text-muted-foreground">Add a shared OpenAI, OpenRouter, or local Ollama connection to get started.</p>}
    {draft.connectionId && !selected && <p role="status" className="text-sm text-muted-foreground">The saved connection is unavailable to you. Disable decisions or choose another connection.</p>}
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="outline" size="sm" onClick={onAdd} disabled={saving || testing}>Add connection</Button>
      {selected && <Link to={`/apps/${selected.id}/permissions`} className="text-sm underline underline-offset-4">{selected.status === "connected" ? "Manage connection" : "Reconnect connection"}</Link>}
    </div>
    {draft.connectionId && <fieldset disabled={saving || testing} className="space-y-4">
      <ToggleField label="Enable decisions" checked={draft.enabled} onChange={enabled => setDraft(value => ({ ...value, enabled }))} />
      <div className="space-y-2">
        <ToggleField label="Allow company-sponsored background decisions" checked={draft.allowBackground} onChange={allowBackground => setDraft(value => ({ ...value, allowBackground }))} />
        <p className="text-xs text-muted-foreground">Background features can charge this connection without a responsible person. These requests appear as Paperclip services.</p>
      </div>
    </fieldset>}
    {incompatibleNotice && <InlineBanner tone="warning" compact>{incompatibleNotice}</InlineBanner>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!dirty && unavailable && <p role="alert" className="text-sm text-destructive">{unavailable}</p>}
    {!dirty && result?.status === "succeeded" && <div role="status" className="space-y-2 text-sm">
      <p className="font-medium">Decision model is working</p>
      <dl className="grid grid-cols-2 gap-2">{Object.entries(result.answers).map(([name, answer]) => <div key={name}>
        <dt className="text-muted-foreground">{name === "billing" ? "Billing problem" : name === "team" ? "Assigned team" : "Disruption score"}</dt>
        <dd className="font-mono">{answer.type === "boolean" ? `${Math.round(answer.probability * 100)}%` : answer.type === "choice" ? answer.choice : `${answer.score.toFixed(2)} / 2`}</dd>
      </div>)}</dl>
      <p className="text-xs text-muted-foreground">Usage was recorded. Test answers are not saved.</p>
    </div>}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="space-y-1">
        <Button variant="outline" size="sm" disabled={!settings.enabled || dirty || saving || testing || selected?.status !== "connected"} onClick={onTest}>{testing ? "Running test…" : "Run test"}</Button>
        <p className="text-xs text-muted-foreground">{dirty ? "Save changes before testing." : "Runs a small sample that may incur a provider charge."}</p>
      </div>
      {dirty && <Button onClick={() => onSave(draft)} disabled={saving || testing || (draft.enabled && selected?.status !== "connected")}>{saving ? "Saving…" : "Save decision model"}</Button>}
    </div>
  </section>;
}

export function DecisionModelSettingsSection({ companyId }: { companyId: string }) {
  const client = useQueryClient();
  const key = ["decision-model", companyId];
  const query = useQuery({ queryKey: key, queryFn: () => decisionModelsApi.settings(companyId) });
  const view = useQueryView(query);
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState<DecisionProvider | null>(null);
  const [newlyConnectedId, setNewlyConnectedId] = useState<string | null>(null);
  const [incompatibleNotice, setIncompatibleNotice] = useState<string | null>(null);
  const settingsRevision = JSON.stringify(query.data?.settings ?? { companyId });
  const test = useMutation({ mutationFn: (_revision: string) => decisionModelsApi.test(companyId), onSettled: () => { void client.invalidateQueries({ queryKey: ["decision-history", companyId] }); void client.invalidateQueries({ predicate: q => String(q.queryKey[0]).includes("cost") }); } });
  const resetTest = test.reset;
  useEffect(() => { resetTest(); }, [settingsRevision, resetTest]);
  const save = useMutation({ mutationFn: (settings: UpdateDecisionModel) => decisionModelsApi.update(companyId, settings), onSuccess: settings => {
    setNewlyConnectedId(null); setIncompatibleNotice(null); test.reset(); client.setQueryData(key, { ...query.data, settings });
  } });
  async function finishSetup(connectedProvider: DecisionProvider, connectionId: string | undefined) {
    const refreshed = await query.refetch();
    if (connectionId) {
      if (refreshed.data?.choices.some(row => row.id === connectionId)) setNewlyConnectedId(connectionId);
      else setIncompatibleNotice(INCOMPATIBLE_CONNECTION_NOTICES[connectedProvider]);
    }
    setAdding(false);
  }
  // Loaded settings stay on screen through an outage (`stale`); only a real
  // failure with nothing cached shows the error.
  if (view.kind === "loading" || view.kind === "reconnecting") return <QueryPlaceholder size="inline" label="Loading decision model" />;
  if (view.kind === "error") return <QueryErrorState size="panel" error={query.error} action="load decision settings" onRetry={view.retry} retrying={view.isFetching} />;
  if (!query.data?.canManage || !query.data.settings) return null;
  const testError = test.variables === settingsRevision ? test.error : null;
  return <>
    <DecisionModelSettingsView settings={query.data.settings} choices={query.data.choices} saving={save.isPending} testing={test.isPending}
      error={save.error ? describeError(save.error).body : testError ? describeError(testError).body : undefined}
      result={test.variables === settingsRevision ? test.data : null} newlyConnectedId={newlyConnectedId} incompatibleNotice={incompatibleNotice}
      onSave={value => save.mutate(value)} onTest={() => test.mutate(settingsRevision)} onAdd={() => { setProvider(null); setIncompatibleNotice(null); setAdding(true); }} />
    <Dialog open={adding} onOpenChange={setAdding}>
      <DialogContent className="sm:max-w-2xl max-h-(--sz-85vh) overflow-y-auto">
        <DialogHeader><DialogTitle>Add a decision connection</DialogTitle><DialogDescription>Use a shared connection for company decisions.</DialogDescription></DialogHeader>
        {provider === "ollama" ? <AiProviderSetup companyId={companyId} initialProvider="local" initialAuth="none" providerLabel={DECISION_PROVIDER_PRESENTATION.ollama.name}
          onCancel={() => setAdding(false)} onComplete={binding => finishSetup(provider, binding.connectionId)} />
        : provider ? <ConnectionSetupFlow host="dialog" serviceSlug={DECISION_PROVIDER_PRESENTATION[provider].serviceSlug} forceNewConnection
          aiConnection={{ provider: DECISION_PROVIDER_PRESENTATION[provider].aiProvider, method: "api_key", mode: "shared" }} requiredAiOwnership="shared"
          onCancel={() => setAdding(false)} onComplete={result => finishSetup(provider, "connectionId" in result ? result.connectionId : undefined)} />
        : <ConnectionChoiceList choices={(Object.keys(DECISION_MODELS) as DecisionProvider[]).map(id => ({ id,
            name: DECISION_PROVIDER_PRESENTATION[id].name, description: DECISION_MODELS[id].name,
            icon: <AppLogo name={DECISION_PROVIDER_PRESENTATION[id].name} brandKey={DECISION_PROVIDER_PRESENTATION[id].brandKey} size={24} />,
          }))} onSelect={id => setProvider(id as DecisionProvider)} />}
      </DialogContent>
    </Dialog>
  </>;
}
