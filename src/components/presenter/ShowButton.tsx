import { Button, type ButtonProps } from "@/components/ui/button";

/**
 * A button of the show: over the slide, or in the presenter view. It is shadcn's `Button` in the
 * `presenter` look and 32px unless said otherwise, and pressing it leaves the keyboard focus
 * where it was, so Space still advances the slide instead of pressing the button again.
 *
 * The show is dark in either theme (a `DarkScope`), and so is the button's tooltip.
 */
export function ShowButton(props: ButtonProps) {
  return <Button variant="presenter" size="icon" keepFocus {...props} />;
}
