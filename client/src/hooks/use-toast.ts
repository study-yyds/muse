import { toast } from "@/components/ui/toast";

interface ToastOptions {
  title?: string;
  description?: string;
  variant?: "default" | "destructive";
}

export function useToast() {
  return {
    toast: (options: ToastOptions) => {
      const type = options.variant === "destructive" ? "error" : "success";
      toast.add({
        title: options.title,
        description: options.description,
        type,
        timeout: 3000,
      });
    },
    dismiss: (id?: string) => toast.close(id),
  };
}
