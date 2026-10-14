import { useState } from "react";
import { Image, Text, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { router } from "expo-router";
import type { ReceiptScanResult } from "@et/shared";
import { Button, Card, CategoryBadge, ErrorCard, Label, Screen } from "@/components/ui";
import { api } from "@/lib/api";
import { useData } from "@/lib/data";
import { money } from "@/lib/format";

/**
 * The API gives the receipt's day as YYYY-MM-DD, which new Date() reads as UTC midnight: 02:00 in Budapest and the
 * previous day west of UTC. Noon local time keeps the printed day.
 */
function receiptDate(d: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : new Date(d);
}

/**
 * Re-encodes the photo as JPEG, at most 1600 px on the longer side, before upload. The picker keeps the EXIF data
 * (GPS position, device) on Android even when it compresses, and passes an iPhone HEIC from the gallery through as it
 * is; a decoded and re-encoded bitmap carries neither.
 */
async function reencode(asset: ImagePicker.ImagePickerAsset) {
  try {
    const ctx = ImageManipulator.manipulate(asset.uri);
    if (Math.max(asset.width, asset.height) > 1600) ctx.resize(asset.width >= asset.height ? { width: 1600 } : { height: 1600 });
    const image = await ctx.renderAsync();
    return (await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 })).uri;
  } catch (e) {
    // Sent as is, the photo would carry its EXIF data, so it is not sent at all.
    throw new Error(`A képet nem sikerült feltöltésre előkészíteni: ${(e as Error).message}`);
  }
}

export default function Scan() {
  const { categoryMap } = useData();
  const [uri, setUri] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReceiptScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pick(camera: boolean) {
    setError(null);
    setResult(null);
    const perm = camera ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setError(camera ? "A kamera engedély nincs megadva." : "A galéria engedély nincs megadva.");
      return;
    }
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.7 };
    const res = camera ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (res.canceled) return;
    const asset = res.assets[0]!;
    setUri(asset.uri);
    setBusy(true);
    try {
      setResult(await api.scanReceipt(await reencode(asset), "image/jpeg", "receipt.jpg"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (!result) return;
    router.push({
      pathname: "/tx",
      params: {
        draft: JSON.stringify({
          amount: result.total != null ? -Math.abs(result.total) : undefined,
          currency: result.currency ?? "HUF",
          merchant: result.merchant ?? "",
          date: (result.date ? receiptDate(result.date) : new Date()).toISOString(),
          categoryId: result.suggestedCategoryId,
          items: result.items,
          source: "receipt",
        }),
      },
    });
  }

  const cat = result?.suggestedCategoryId ? categoryMap.get(result.suggestedCategoryId) : undefined;

  return (
    <Screen title="Blokk beolvasása" subtitle="Fotózd le, az AI kiolvassa a tételeket és az összeget.">
      <View className="flex-row gap-3">
        <Button title="Fotó készítése" onPress={() => pick(true)} className="flex-1" disabled={busy} />
        <Button title="Galéria" variant="outline" onPress={() => pick(false)} disabled={busy} />
      </View>
      {uri ? <Image source={{ uri }} className="h-72 w-full rounded-2xl" resizeMode="contain" /> : null}
      {busy ? <Card><Text className="text-sm text-muted-fg dark:text-muted-fg-dark">Feldolgozás…</Text></Card> : null}
      {error ? <ErrorCard message={error} /> : null}
      {result ? (
        <Card className="gap-3">
          <View className="flex-row items-center gap-3">
            <CategoryBadge category={cat} size={44} />
            <View className="flex-1">
              <Text className="font-medium text-fg dark:text-fg-dark">{result.merchant ?? "Ismeretlen kereskedő"}</Text>
              <Text className="text-xs text-muted-fg dark:text-muted-fg-dark">{result.date ?? "Dátum nem olvasható"} · {Math.round(result.confidence * 100)}% biztos</Text>
            </View>
          </View>
          {result.items.map((it, i) => (
            <View key={i} className="flex-row justify-between">
              <Text numberOfLines={1} className="flex-1 text-sm text-fg dark:text-fg-dark">{it.quantity > 1 ? `${it.quantity}× ` : ""}{it.name}</Text>
              <Text className="text-sm text-muted-fg dark:text-muted-fg-dark">{money(it.total, result.currency ?? "HUF")}</Text>
            </View>
          ))}
          <View className="flex-row items-baseline justify-between border-t border-line pt-3 dark:border-line-dark">
            <Label>Összesen</Label>
            <Text className="text-2xl font-semibold text-fg dark:text-fg-dark">{result.total != null ? money(result.total, result.currency ?? "HUF") : "nem olvasható"}</Text>
          </View>
          <Button title="Ellenőrzés és mentés" onPress={save} />
        </Card>
      ) : null}
    </Screen>
  );
}
