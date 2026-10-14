import { useEffect, useState } from "react";
import { Text, TextInput } from "react-native";
import { Button, Card, Label, Screen, useTheme } from "@/components/ui";
import { api, getApiToken, getApiUrl, setApiToken, setApiUrl } from "@/lib/api";
import { useData } from "@/lib/data";

export default function Settings() {
  const t = useTheme();
  const { refresh } = useData();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getApiUrl().then(setUrl);
    getApiToken().then(setToken);
  }, []);

  async function saveAndTest() {
    setBusy(true);
    try {
      await setApiUrl(url);
      await setApiToken(token);
      const h = await api.health();
      setStatus({ ok: true, text: `Kapcsolódva · AI: ${h.ai.provider} (${h.ai.model})` });
      await refresh();
    } catch (e) {
      setStatus({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title="Beállítások" subtitle="A telefon a gépeden vagy szerveren futó moncsy API-hoz kapcsolódik.">
      <Card className="gap-3">
        <Label>API cím</Label>
        <TextInput
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="http://192.168.1.20:8787"
          placeholderTextColor={t.muted}
          className="h-11 rounded-xl border border-line bg-bg px-3 text-fg dark:border-line-dark dark:bg-bg-dark dark:text-fg-dark"
        />
        <Text className="text-xs text-muted-fg dark:text-muted-fg-dark">
          Telefonról a „localhost” maga a telefon. Add meg a gép helyi IP címét, és az API-t indítsd HOST=0.0.0.0 beállítással.
        </Text>
        <Label>API token</Label>
        <TextInput
          value={token}
          onChangeText={setToken}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          textContentType="password"
          placeholder="A szerveren beállított token"
          placeholderTextColor={t.muted}
          className="h-11 rounded-xl border border-line bg-bg px-3 font-mono text-fg dark:border-line-dark dark:bg-bg-dark dark:text-fg-dark"
        />
        <Text className="text-xs text-muted-fg dark:text-muted-fg-dark">
          Minden kéréshez csatolva megy, a telefon biztonságos tárolójában (Keychain / Keystore) marad.
        </Text>
        <Button title="Mentés és kapcsolat ellenőrzése" onPress={saveAndTest} loading={busy} />
        {status ? (
          <Text className={`text-sm ${status.ok ? "text-positive dark:text-positive-dark" : "text-danger dark:text-danger-dark"}`}>{status.text}</Text>
        ) : null}
      </Card>
    </Screen>
  );
}
