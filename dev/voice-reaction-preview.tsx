import { createRoot } from "react-dom/client";
import { VoiceReactionStudio } from "@/components/chat/voice-reaction-studio";
declare global { interface Window { reactionModels?: {label:string;url:string}[] } }
createRoot(document.getElementById("root")!).render(<VoiceReactionStudio modelOptions={window.reactionModels}/>);
