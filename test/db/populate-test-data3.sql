insert into webhooks(webhook_sid, url, username, password) values('90dda62e-0ea2-47d1-8164-5bd49003476c', 'http://127.0.0.1:4000/auth', 'foo', 'bar');

insert into service_providers (service_provider_sid, name, root_domain, registration_hook_sid) 
values ('3f35518f-5a0d-4c2e-90a5-2407bb3b36f0', 'SP A', 'jambonz.org', '90dda62e-0ea2-47d1-8164-5bd49003476c');
insert into accounts(account_sid, service_provider_sid, name, sip_realm, registration_hook_sid)
values ('ed649e33-e771-403a-8c99-1780eabbc803', '3f35518f-5a0d-4c2e-90a5-2407bb3b36f0', 'test account', 'sip.example.com', '90dda62e-0ea2-47d1-8164-5bd49003476c');

-- "good" carrier - "westco" at 172.39.0.20
insert into voip_carriers (voip_carrier_sid, name) values ('287c1452-620d-4195-9f19-c9814ef90d78', 'westco');
insert into sip_gateways (sip_gateway_sid, voip_carrier_sid, ipv4, inbound, outbound) 
values ('124a5339-c62c-4075-9e19-f4de70a96597', '287c1452-620d-4195-9f19-c9814ef90d78', '172.39.0.20', true, true);

-- "bad" carrier - "eastco" at 172.39.0.21 (returns 503)
insert into voip_carriers (voip_carrier_sid, name) values ('1d8ef351-062a-4487-94f8-7698d5a40d24', 'eastco');
insert into sip_gateways (sip_gateway_sid, voip_carrier_sid, ipv4, inbound, outbound) 
values ('e71519ff-4494-4c98-a06a-324e2712d94b', '1d8ef351-062a-4487-94f8-7698d5a40d24', '172.39.0.21', true, true);

-- "bad" carrier - "northco" at 172.39.0.22 (returns 100 Trying and never answers)
insert into voip_carriers (voip_carrier_sid, name) values ('7b4b9c56-4d81-4f31-9d70-62cd7d82193b', 'northco');
insert into sip_gateways (sip_gateway_sid, voip_carrier_sid, ipv4, inbound, outbound) 
values ('fcbb2109-582c-4d55-b38a-b6bc7cc4be73', '7b4b9c56-4d81-4f31-9d70-62cd7d82193b', '172.39.0.22', true, true);

-- lcr route: first try eastco (503) then northco (cancel), then westco (200)
insert into lcr_routes(lcr_route_sid, regex, priority) values ('0eba4204-b036-4388-8f47-724c4cfb3d4e', '.*', 1);

insert into lcr_carrier_set_entry(lcr_carrier_set_entry_sid, lcr_route_sid, voip_carrier_sid, priority)
values ('b677a7b5-bec6-4045-ae4a-a67a5ccb3448', '0eba4204-b036-4388-8f47-724c4cfb3d4e', '1d8ef351-062a-4487-94f8-7698d5a40d24', 1);
insert into lcr_carrier_set_entry(lcr_carrier_set_entry_sid, lcr_route_sid, voip_carrier_sid, priority)
values ('b417ce66-a805-46b3-b296-697a6c2ca249', '0eba4204-b036-4388-8f47-724c4cfb3d4e', '7b4b9c56-4d81-4f31-9d70-62cd7d82193b', 2);
insert into lcr_carrier_set_entry(lcr_carrier_set_entry_sid, lcr_route_sid, voip_carrier_sid, priority)
values ('13e344a0-8a4c-4f95-8a19-ccbfc7ab053e', '0eba4204-b036-4388-8f47-724c4cfb3d4e', '287c1452-620d-4195-9f19-c9814ef90d78', 3);

