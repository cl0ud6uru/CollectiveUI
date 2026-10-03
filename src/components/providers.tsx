"use client";

import { ThemeProvider } from "next-themes";
import { Tooltip } from "radix-ui";
import { Toaster } from "sonner";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <Tooltip.Provider delayDuration={300}>
        {children}
        <Toaster position="top-center" richColors />
      </Tooltip.Provider>
    </ThemeProvider>
  );
}
