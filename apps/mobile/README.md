# moncsy mobil (Expo)

Expo SDK 57, Expo Router, NativeWind (Tailwind). Ugyanazt az API-t használja, mint a web (`packages/shared` szerződés).

```bash
pnpm --filter @et/mobile start      # Expo Go / dev build
```

- A telefonról a `localhost` maga a telefon: a Beállításokban add meg a gép helyi IP címét (`http://192.168.x.y:8787`), vagy építsd be: `EXPO_PUBLIC_API_URL=...`.
- Ehhez az API-t `HOST=0.0.0.0`-val kell indítani. Az API-n még nincs bejelentkezés, így ilyenkor a helyi hálózaton bárki elérheti: csak megbízható hálózaton.
- Blokkfotó: `expo-image-picker`, JPEG-re tömörítve küldi (az iPhone HEIC így is olvasható az AI-nak).
