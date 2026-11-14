// Whether the command palette is open. Its code loads on first use (see ../components/lazy.tsx);
// this is all the window starts with.
import { create } from "zustand";

export const usePalette = create<{ open: boolean }>(() => ({ open: false }));

export const openPalette = () => usePalette.setState({ open: true });
export const closePalette = () => usePalette.setState({ open: false });
