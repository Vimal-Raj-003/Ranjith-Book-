import ScheduleBoard from "@/components/schedule/ScheduleBoard";
import SignIn from "@/components/SignIn";
import { currentUser } from "@/lib/auth/session";
import "./schedule.css";

export const dynamic="force-dynamic";
export default async function SchedulePage() {
  const user=await currentUser();
  return user?<ScheduleBoard/>:<SignIn/>;
}
