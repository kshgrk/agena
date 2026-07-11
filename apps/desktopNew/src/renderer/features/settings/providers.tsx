import type {
  ProviderAuthSummary,
  ProviderOAuthStatusResponse,
} from "@agena/protocol";
import { KeyRound, Link2, Unplug } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getBridge } from "../../lib/bridge.ts";
import { formatBridgeError } from "../../lib/errors.ts";
import { refreshRuntimeInfo } from "../../store/connection.ts";
import { pushToast } from "../../store/index.ts";
import {
  Badge,
  Button,
  Input,
  Select,
  Spinner,
  StatusDot,
  Textarea,
} from "../../ui/index.ts";
import {
  EmptyRow,
  Field,
  GroupLabel,
  InlineError,
  ListCard,
  LoadingRow,
  RefreshButton,
  SectionHeader,
  useLoad,
} from "./common.tsx";
import { parseProviderEnv } from "./providers-lib.ts";

const POLL_MS = 1200;

function sourceLabel(provider: ProviderAuthSummary): string {
  if (!provider.configured) return "Not connected";
  if (provider.credentialKind === "oauth") return "Subscription connected";
  if (provider.credentialKind === "api_key") return "API key saved";
  if (provider.source === "environment")
    return provider.label
      ? `Deployment · ${provider.label}`
      : "Deployment credential";
  return "Connected";
}

function ProviderRow({
  provider,
  flow,
  onChanged,
  onFlow,
}: {
  provider: ProviderAuthSummary;
  flow: ProviderOAuthStatusResponse | null;
  onChanged: () => Promise<void>;
  onFlow: (flow: ProviderOAuthStatusResponse) => void;
}) {
  const [editingKey, setEditingKey] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [env, setEnv] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await action();
      await refreshRuntimeInfo();
      await onChanged();
      if (success) pushToast({ kind: "ok", title: success });
    } catch (error) {
      pushToast({
        kind: "err",
        title: "Provider update failed",
        detail: formatBridgeError(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      const extra = parseProviderEnv(env);
      await getBridge().saveProviderApiKey(provider.id, {
        apiKey,
        ...(extra ? { env: extra } : {}),
      });
      setApiKey("");
      setEditingKey(false);
    }, `${provider.name} connected`);

  const connect = async () => {
    setBusy(true);
    try {
      const next = await getBridge().startProviderOAuth(provider.id);
      onFlow({ ...next, providerId: provider.id });
      if (next.state === "completed") {
        await refreshRuntimeInfo();
        await onChanged();
      }
    } catch (error) {
      pushToast({
        kind: "err",
        title: "Authorization failed",
        detail: formatBridgeError(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const respond = () => {
    const interaction = flow?.interaction;
    if (!flow || interaction?.kind !== "prompt") return;
    void run(async () => {
      await getBridge().respondProviderOAuth(flow.flowId, {
        action: "respond",
        interactionId: interaction.interactionId,
        value: answer,
      });
      setAnswer("");
    });
  };

  const prompt = flow?.interaction?.kind === "prompt" ? flow.interaction : null;
  return (
    <div className="p-3">
      <div className="flex items-center gap-2">
        <StatusDot
          className={provider.configured ? "bg-success" : "bg-fg-faint"}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-fg">
            {provider.name}
          </div>
          <div className="text-xs text-fg-muted">
            {sourceLabel(provider)} · {provider.modelCount} models
          </div>
        </div>
        {provider.methods.map((method) => (
          <Badge key={method} tone="neutral">
            {method === "oauth" ? "Subscription" : "API key"}
          </Badge>
        ))}
        {provider.methods.includes("oauth") &&
        provider.credentialKind !== "oauth" ? (
          <Button
            size="sm"
            variant="primary"
            disabled={busy || flow?.state === "pending"}
            onClick={() => void connect()}
          >
            <Link2 /> Connect subscription
          </Button>
        ) : null}
        {provider.methods.includes("api_key") ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEditingKey((v) => !v)}
          >
            <KeyRound /> {provider.configured ? "Replace" : "Add key"}
          </Button>
        ) : null}
        {provider.configured ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run(
                () => getBridge().removeProviderAuth(provider.id),
                `${provider.name} disconnected`,
              )
            }
          >
            <Unplug />
          </Button>
        ) : null}
      </div>

      {editingKey ? (
        <div className="mt-3 space-y-3 border-t border-border-subtle pt-3">
          <Field label="API key">
            <Input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="Paste provider key"
            />
          </Field>
          <Field
            label="Additional settings"
            hint="Optional provider settings, one NAME=value per line (for example account, gateway, region, or endpoint)."
          >
            <Textarea
              rows={2}
              value={env}
              onChange={(event) => setEnv(event.target.value)}
              placeholder="CLOUDFLARE_ACCOUNT_ID=…"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditingKey(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!apiKey || busy}
              onClick={() => void save()}
            >
              {busy ? <Spinner /> : null} Save
            </Button>
          </div>
        </div>
      ) : null}

      {flow?.state === "pending" ? (
        <div className="mt-3 rounded-md border border-border-subtle bg-inset p-3 text-sm">
          {flow.interaction?.kind === "auth_url" ? (
            <span className="text-fg-secondary">
              Continue in the system browser…
            </span>
          ) : flow.interaction?.kind === "device_code" ? (
            <div>
              <div className="text-fg-secondary">
                Enter this code in the browser:
              </div>
              <div className="mt-1 font-mono text-lg font-semibold tracking-wider text-fg">
                {flow.interaction.userCode}
              </div>
            </div>
          ) : flow.interaction?.kind === "progress" ? (
            <span className="flex items-center gap-2 text-fg-secondary">
              <Spinner /> {flow.interaction.message}
            </span>
          ) : prompt ? (
            <div className="space-y-2">
              <div className="text-fg-secondary">{prompt.message}</div>
              {prompt.inputKind === "select" ? (
                <Select
                  value={answer}
                  onValueChange={setAnswer}
                  placeholder="Choose…"
                  options={(prompt.options ?? []).map((option) => ({
                    value: option.id,
                    label: option.label,
                  }))}
                />
              ) : (
                <Input
                  type={prompt.inputKind === "secret" ? "password" : "text"}
                  value={answer}
                  placeholder={prompt.placeholder}
                  onChange={(event) => setAnswer(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") respond();
                  }}
                />
              )}
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() =>
                    void getBridge().respondProviderOAuth(flow.flowId, {
                      action: "cancel",
                    })
                  }
                >
                  Cancel
                </Button>
                <Button variant="primary" onClick={respond}>
                  Continue
                </Button>
              </div>
            </div>
          ) : (
            <span className="flex items-center gap-2 text-fg-secondary">
              <Spinner /> Waiting for authorization…
            </span>
          )}
        </div>
      ) : null}
      {flow?.state === "failed" ? (
        <div className="mt-2 text-xs text-danger">
          {flow.error ?? "Authorization failed"}
        </div>
      ) : null}
    </div>
  );
}

export function ProvidersSection() {
  const loadProviders = useCallback(() => getBridge().listProviders(), []);
  const loaded = useLoad(loadProviders);
  const [flows, setFlows] = useState<
    Record<string, ProviderOAuthStatusResponse>
  >({});
  const reload = loaded.reload;

  useEffect(() => {
    const pending = Object.values(flows).filter(
      (flow) => flow.state === "pending",
    );
    if (!pending.length) return;
    const timer = setInterval(() => {
      for (const flow of pending) {
        void getBridge()
          .providerOAuthStatus(flow.flowId)
          .then(async (next) => {
            setFlows((current) => ({ ...current, [next.providerId]: next }));
            if (next.state === "completed") {
              await refreshRuntimeInfo();
              await reload();
              pushToast({ kind: "ok", title: "Provider connected" });
            }
          })
          .catch(() => {});
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [flows, reload]);

  return (
    <div>
      <SectionHeader
        title="Providers"
        description="Connect subscriptions or API keys used by Pi models. Credentials stay in the Agena daemon."
        actions={
          <RefreshButton
            disabled={loaded.loading}
            onClick={() => void loaded.reload(true)}
          >
            Refresh
          </RefreshButton>
        }
      />
      {loaded.error ? (
        <InlineError
          error={loaded.error}
          onRetry={() => void loaded.reload()}
        />
      ) : null}
      <GroupLabel>Model providers</GroupLabel>
      <ListCard>
        {!loaded.data && loaded.loading ? <LoadingRow /> : null}
        {loaded.data?.length === 0 ? (
          <EmptyRow>No providers reported by Pi.</EmptyRow>
        ) : null}
        {loaded.data?.map((provider) => (
          <ProviderRow
            key={provider.id}
            provider={provider}
            flow={flows[provider.id] ?? null}
            onChanged={() => loaded.reload(true)}
            onFlow={(flow) =>
              setFlows((current) => ({ ...current, [provider.id]: flow }))
            }
          />
        ))}
      </ListCard>
    </div>
  );
}
