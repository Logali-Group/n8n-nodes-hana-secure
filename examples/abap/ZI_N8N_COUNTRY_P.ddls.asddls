@AbapCatalog.sqlViewName: 'ZN8NCOUNTRYP'
@AbapCatalog.compiler.compareFilter: true
@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'n8n country lookup demo'
@Metadata.ignorePropagatedAnnotations: true
define view ZI_N8N_COUNTRY_P
  with parameters
    p_country : land1
  as select from I_Country
{
  key Country,
      CountryThreeLetterISOCode,
      CountryThreeDigitISOCode,
      CountryISOCode,
      IsEuropeanUnionMember
}
where Country = $parameters.p_country
