import "../../global.css";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useColorScheme } from "react-native";
import { DataProvider } from "@/lib/data";

export default function RootLayout() {
  const dark = useColorScheme() === "dark";
  return (
    <SafeAreaProvider>
      <DataProvider>
        <StatusBar style={dark ? "light" : "dark"} />
        <Stack
          screenOptions={{
            headerShown: false,
            // Calm cross-fade between screens instead of a hard push.
            animation: "fade",
            contentStyle: { backgroundColor: dark ? "#1a1b1f" : "#f7f6f2" },
          }}
        >
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="tx" options={{ presentation: "modal", animation: "slide_from_bottom" }} />
        </Stack>
      </DataProvider>
    </SafeAreaProvider>
  );
}
