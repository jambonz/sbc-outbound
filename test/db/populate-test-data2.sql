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

-- "good" carrier - "westco" at 172.39.0.20
insert into voip_carriers (voip_carrier_sid, name, service_provider_sid) values ('287c1452-620d-4195-9f19-c9814ef90d78', 'westco', '3f35518f-5a0d-4c2e-90a5-2407bb3b36f0');
insert into sip_gateways (sip_gateway_sid, voip_carrier_sid, ipv4, inbound, outbound) 
values ('124a5339-c62c-4075-9e19-f4de70a96597', '287c1452-620d-4195-9f19-c9814ef90d78', '172.39.0.20', true, true);

-- "bad" carrier - "eastco" at 172.39.0.21 (returns 503)
insert into voip_carriers (voip_carrier_sid, name, service_provider_sid) values ('1d8ef351-062a-4487-94f8-7698d5a40d24', 'eastco', '3f35518f-5a0d-4c2e-90a5-2407bb3b36f0');
insert into sip_gateways (sip_gateway_sid, voip_carrier_sid, ipv4, inbound, outbound) 
values ('e71519ff-4494-4c98-a06a-324e2712d94b', '1d8ef351-062a-4487-94f8-7698d5a40d24', '172.39.0.21', true, true);

-- lcr route: default eastco, but 1617 matches westco (503)
insert into lcr(lcr_sid, account_sid) 
values('c0b0b6a0-0b0a-4b0b-8b0b-0b0b0b0b0b0b', 'ed649e33-e771-403a-8c99-1780eabbc803');

insert into lcr_routes(lcr_route_sid, lcr_sid, regex, priority) 
values ('9eba4204-b036-4388-8f47-724c4cfb3d4e', 'c0b0b6a0-0b0a-4b0b-8b0b-0b0b0b0b0b0b', '.*', 999);

insert into lcr_carrier_set_entry(lcr_carrier_set_entry_sid, lcr_route_sid, voip_carrier_sid, priority)
values ('13e344a0-8a4c-4f95-8a19-ccbfc7ab053e', '9eba4204-b036-4388-8f47-724c4cfb3d4e', '1d8ef351-062a-4487-94f8-7698d5a40d24', 1);

-- attach default route to lcr
update lcr set default_carrier_set_entry_sid = '13e344a0-8a4c-4f95-8a19-ccbfc7ab053e';

-- add a route based on digit match
insert into lcr_routes(lcr_route_sid, lcr_sid, regex, priority) 
values ('3eba4204-b036-4388-8f47-724c4cfb3d4e', 'c0b0b6a0-0b0a-4b0b-8b0b-0b0b0b0b0b0b', '1617', 1);

insert into lcr_carrier_set_entry(lcr_carrier_set_entry_sid, lcr_route_sid, voip_carrier_sid, priority)
values ('b677a7b5-bec6-4045-ae4a-a67a5ccb3448', '3eba4204-b036-4388-8f47-724c4cfb3d4e', '287c1452-620d-4195-9f19-c9814ef90d78', 1);

