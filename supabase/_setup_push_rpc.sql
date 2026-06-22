-- Función segura para registrar una suscripción push sin exponer la tabla.
-- Corre como definer (dueño) → puede hacer el upsert aunque la tabla esté
-- cerrada a anon. Así el celular NO necesita SELECT/INSERT directo.
create or replace function public.registrar_push(
    p_endpoint   text,
    p_p256dh     text,
    p_auth       text,
    p_user_agent text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.push_subscriptions (endpoint, p256dh, auth, user_agent)
    values (p_endpoint, p_p256dh, p_auth, p_user_agent)
    on conflict (endpoint) do update
        set p256dh     = excluded.p256dh,
            auth       = excluded.auth,
            user_agent = excluded.user_agent;
end;
$$;

-- Solo permitimos EJECUTAR la función al rol anónimo.
revoke all on function public.registrar_push(text, text, text, text) from public;
grant execute on function public.registrar_push(text, text, text, text) to anon, authenticated;

-- Cerramos el acceso directo a la tabla: quitamos permisos y políticas de anon.
revoke insert, update on public.push_subscriptions from anon;
drop policy if exists "anon puede insertar suscripcion" on public.push_subscriptions;
drop policy if exists "anon puede actualizar suscripcion" on public.push_subscriptions;

-- Limpiamos las filas de prueba que metí al diagnosticar.
delete from public.push_subscriptions where user_agent = 'prueba-claude';

-- Y la función de diagnóstico ya no la necesitamos.
drop function if exists public.quien_soy();
