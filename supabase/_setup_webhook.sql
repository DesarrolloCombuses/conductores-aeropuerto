-- Webhook: cuando se INSERTA un despacho en despachos_realizados,
-- llama a la Edge Function enviar-push (que filtra AEROPUERTO y manda la push).

create or replace function public.notificar_despacho_push()
returns trigger
language plpgsql
security definer
set search_path = public, net, extensions
as $$
begin
  perform net.http_post(
    url     := 'https://cbplebkmxrkaafqdhiyi.supabase.co/functions/v1/enviar-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_DZCceNTENY4ViP17-eZrGg_bdMElZ9X',
      'Authorization', 'Bearer sb_publishable_DZCceNTENY4ViP17-eZrGg_bdMElZ9X'
    ),
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', TG_TABLE_NAME,
      'record', row_to_json(NEW)
    ),
    timeout_milliseconds := 5000
  );
  return NEW;
end;
$$;

drop trigger if exists trg_notificar_despacho_push on public.despachos_realizados;
create trigger trg_notificar_despacho_push
  after insert on public.despachos_realizados
  for each row
  execute function public.notificar_despacho_push();
