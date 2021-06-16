-- create our products
insert into products (product_sid, name, category)
values
('c4403cdb-8e75-4b27-9726-7d8315e3216d', 'concurrent call session', 'voice_call_session'),
('2c815913-5c26-4004-b748-183b459329df', 'registered device', 'device'),
('35a9fb10-233d-4eb9-aada-78de5814d680', 'api call', 'api_rate');

insert into webhooks(webhook_sid, url, username, password) values('90dda62e-0ea2-47d1-8164-5bd49003476c', 'http://127.0.0.1:4000/auth', 'foo', 'bar');

insert into service_providers (service_provider_sid, name, root_domain, registration_hook_sid) 
values ('3f35518f-5a0d-4c2e-90a5-2407bb3b36f0', 'SP A', 'jambonz.org', '90dda62e-0ea2-47d1-8164-5bd49003476c');

insert into accounts(account_sid, service_provider_sid, name, sip_realm, registration_hook_sid, webhook_secret)
values ('ed649e33-e771-403a-8c99-1780eabbc803', '3f35518f-5a0d-4c2e-90a5-2407bb3b36f0', 'test account', 'sip.example.com', '90dda62e-0ea2-47d1-8164-5bd49003476c', 'foobar');
insert into account_subscriptions(account_subscription_sid, account_sid, pending)
values ('f4e1848d-3ff8-40eb-b9c1-30e1ef053f94','ed649e33-e771-403a-8c99-1780eabbc803',0);
insert into account_products(account_product_sid, account_subscription_sid, product_sid,quantity)
values ('f23ff996-6534-4aba-8666-4b347391eca2', 'f4e1848d-3ff8-40eb-b9c1-30e1ef053f94', 'c4403cdb-8e75-4b27-9726-7d8315e3216d', 10);

-- one carrier, uas script expecting a reinvite
insert into voip_carriers (voip_carrier_sid, name, service_provider_sid, e164_leading_plus, requires_register, register_username, register_sip_realm, register_password) 
values ('287c1452-620d-4195-9f19-c9814ef90d78', 'westco', '3f35518f-5a0d-4c2e-90a5-2407bb3b36f0', 0, 1, 'foo', 'jambonz.org', 'bar');
insert into sip_gateways (sip_gateway_sid, voip_carrier_sid, ipv4, inbound, outbound) 
values ('124a5339-c62c-4075-9e19-f4de70a96597', '287c1452-620d-4195-9f19-c9814ef90d78', '172.39.0.23', true, true);
