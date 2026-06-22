-- Tabla de suscripciones Web Push de los conductores
create table if not exists public.push_subscriptions (
    endpoint   text primary key,
    p256dh     text not null,
    auth       text not null,
    user_agent text,
    created_at timestamptz not null default now()
);

-- Seguridad a nivel de fila
alter table public.push_subscriptions enable row level security;

-- Permisos para el rol anónimo (la app de conductores no tiene login):
-- solo puede registrar/actualizar SU suscripción (insert + update por upsert).
-- NO puede leer ni borrar las suscripciones de otros.
grant insert, update on public.push_subscriptions to anon;

-- Políticas RLS: permitir insertar y actualizar al rol anónimo.
drop policy if exists "anon puede insertar suscripcion" on public.push_subscriptions;
create policy "anon puede insertar suscripcion"
    on public.push_subscriptions
    for insert to anon
    with check (true);

drop policy if exists "anon puede actualizar suscripcion" on public.push_subscriptions;
create policy "anon puede actualizar suscripcion"
    on public.push_subscriptions
    for update to anon
    using (true) with check (true);
